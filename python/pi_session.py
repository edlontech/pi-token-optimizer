#!/usr/bin/env python3
"""Read-only Pi v3 session adapter for Token Optimizer."""

from __future__ import annotations

import hashlib
import heapq
import json
import math
import os
import re
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Union

MAX_PARSE_FILE_BYTES = 64 * 1024 * 1024
MAX_JSONL_LINE_CHARS = 8 * 1024 * 1024
MAX_JSON_NUMBER_CHARS = 4_300
MAX_SESSION_ENTRIES = 200_000
MAX_DISCOVERY_FILES = 500
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,128}$")


def _parse_json_int(value: str) -> int:
    if len(value) > MAX_JSON_NUMBER_CHARS:
        raise ValueError("JSON integer is too large")
    return int(value)


def _parse_json_float(value: str) -> float:
    if len(value) > MAX_JSON_NUMBER_CHARS:
        raise ValueError("JSON float is too large")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("JSON float is not finite")
    return number


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def _loads_json(value: str) -> Any:
    return json.loads(
        value,
        parse_int=_parse_json_int,
        parse_float=_parse_json_float,
        parse_constant=_reject_json_constant,
    )


def _session_roots() -> tuple[Path, ...]:
    explicit = os.environ.get("PI_CODING_AGENT_SESSION_DIR")
    if explicit:
        return (Path(explicit).expanduser(),)
    agent_dir = os.environ.get("PI_CODING_AGENT_DIR")
    return (Path(agent_dir).expanduser() / "sessions",) if agent_dir else ()


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _read_header(filepath: Union[str, Path]) -> Optional[dict[str, Any]]:
    path = Path(filepath).expanduser()
    try:
        if path.suffix != ".jsonl" or path.is_symlink() or not path.is_file():
            return None
        if path.stat().st_size > MAX_PARSE_FILE_BYTES:
            return None
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            first = handle.readline(MAX_JSONL_LINE_CHARS + 1)
        if len(first) > MAX_JSONL_LINE_CHARS:
            return None
        header = _loads_json(first)
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    if not isinstance(header, dict) or header.get("type") != "session" or header.get("version") != 3:
        return None
    return header


def is_pi_session_path(path: Union[str, Path]) -> bool:
    candidate = Path(path).expanduser()
    try:
        resolved = candidate.resolve(strict=True)
    except (OSError, ValueError):
        return False
    if candidate.is_symlink() or _read_header(resolved) is None:
        return False

    current = os.environ.get("PI_SESSION_FILE")
    if current:
        try:
            if resolved == Path(current).expanduser().resolve(strict=True):
                return True
        except (OSError, ValueError):
            pass
    for root in _session_roots():
        try:
            if _is_within(resolved, root.resolve(strict=False)):
                return True
        except (OSError, ValueError):
            continue
    return False


def find_current_session_jsonl() -> Optional[Path]:
    value = os.environ.get("PI_SESSION_FILE")
    if not value:
        return None
    path = Path(value).expanduser()
    return path if _read_header(path) is not None else None


def _project_name(header: dict[str, Any], path: Path) -> str:
    cwd = header.get("cwd")
    if isinstance(cwd, str) and cwd:
        return Path(cwd).name or cwd
    return path.parent.name


def _iter_valid_session_files(cutoff: Optional[float] = None):
    seen: set[Path] = set()
    for root in _session_roots():
        try:
            resolved_root = root.resolve(strict=True)
        except (OSError, ValueError):
            continue
        if not resolved_root.is_dir():
            continue
        try:
            paths = root.rglob("*.jsonl")
            for path in paths:
                try:
                    resolved = path.resolve(strict=True)
                    if (
                        path.is_symlink()
                        or resolved in seen
                        or not _is_within(resolved, resolved_root)
                    ):
                        continue
                    mtime = resolved.stat().st_mtime
                except (OSError, ValueError):
                    continue
                if cutoff is not None and mtime < cutoff:
                    continue
                session = _read_session(resolved)
                if session is None or not _active_branch(session[1]):
                    continue
                header, _records = session
                seen.add(resolved)
                yield path, resolved, mtime, header
        except OSError:
            continue


def find_all_jsonl_files(
    days: int = 30,
    max_files: int = MAX_DISCOVERY_FILES,
) -> list[tuple[Path, float, str]]:
    if not isinstance(days, int) or isinstance(days, bool) or days < 0:
        return []
    if not isinstance(max_files, int) or isinstance(max_files, bool) or max_files <= 0:
        return []
    cutoff = datetime.now(timezone.utc).timestamp() - (days * 86400)
    newest = heapq.nlargest(
        max_files,
        _iter_valid_session_files(cutoff),
        key=lambda item: item[2],
    )
    return [
        (path, mtime, _project_name(header, path))
        for path, _resolved, mtime, header in newest
    ]


def find_session_jsonl_by_id(session_id: str) -> Optional[Path]:
    if not isinstance(session_id, str) or not _SESSION_ID_RE.fullmatch(session_id):
        return None

    matches: dict[Path, Path] = {}
    current = find_current_session_jsonl()
    if current is not None:
        header = _read_header(current)
        if header is not None and header.get("id") == session_id:
            try:
                matches[current.resolve(strict=True)] = current
            except (OSError, ValueError):
                return None

    for path, resolved, _mtime, header in _iter_valid_session_files():
        if header.get("id") == session_id:
            matches.setdefault(resolved, path)
    return next(iter(matches.values())) if len(matches) == 1 else None


def _read_session(filepath: Union[str, Path]) -> Optional[tuple[dict[str, Any], list[dict[str, Any]]]]:
    path = Path(filepath).expanduser()
    if not is_pi_session_path(path):
        return None
    try:
        if path.stat().st_size > MAX_PARSE_FILE_BYTES:
            return None
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            first = handle.readline(MAX_JSONL_LINE_CHARS + 1)
            if len(first) > MAX_JSONL_LINE_CHARS:
                return None
            header = _loads_json(first)
            if not isinstance(header, dict) or header.get("type") != "session" or header.get("version") != 3:
                return None

            records: list[dict[str, Any]] = []
            while True:
                line = handle.readline(MAX_JSONL_LINE_CHARS + 1)
                if not line:
                    break
                if len(line) > MAX_JSONL_LINE_CHARS:
                    return None
                try:
                    record = _loads_json(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if isinstance(record, dict):
                    records.append(record)
                    if len(records) > MAX_SESSION_ENTRIES:
                        return None
    except (OSError, json.JSONDecodeError, ValueError):
        return None
    return header, records


def _active_branch(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    entries: dict[str, dict[str, Any]] = {}
    ordered: list[dict[str, Any]] = []
    seen_entry_ids: set[str] = set()
    for record in records:
        entry_id = record.get("id")
        parent_id = record.get("parentId")
        if isinstance(entry_id, str) and entry_id:
            if entry_id in seen_entry_ids:
                return []
            seen_entry_ids.add(entry_id)
        if (
            record.get("type") == "session"
            or not isinstance(entry_id, str)
            or not entry_id
            or (parent_id is not None and not isinstance(parent_id, str))
        ):
            continue
        entries[entry_id] = record
        ordered.append(record)

    if not ordered:
        return []

    branch: list[dict[str, Any]] = []
    current = ordered[-1]
    seen: set[str] = set()
    while True:
        entry_id = current["id"]
        if entry_id in seen:
            return []
        seen.add(entry_id)
        branch.append(current)
        parent_id = current.get("parentId")
        if parent_id is None:
            break
        current = entries.get(parent_id)
        if current is None:
            return []
    branch.reverse()
    return branch


def active_entries(filepath: Union[str, Path]) -> list[dict[str, Any]]:
    """Return the current Pi branch in chronological order, or [] if corrupt."""
    session = _read_session(filepath)
    return _active_branch(session[1]) if session is not None else []


_TOOL_ALIASES = {
    "bash": "Bash",
    "read": "Read",
    "edit": "Edit",
    "write": "Write",
    "grep": "Grep",
    "find": "Glob",
    "ls": "Glob",
}
_DECISION_RE = re.compile(
    r"\b(chose|decided|because|instead of|went with|going with|switched|prefer|should use|will use)\b",
    re.IGNORECASE,
)
_ERROR_RE = re.compile(
    r"\b(error|failed|traceback|exception|permission denied|not found)\b",
    re.IGNORECASE,
)
_TOPIC_PREFIXES = (
    "implement the following plan:",
    "please implement",
    "can you help me",
    "i need help with",
    "help me",
    "i want to",
    "i'd like to",
)


def _safe_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value))
    except (OverflowError, TypeError, ValueError):
        return 0


def _safe_float(value: Any) -> float:
    if isinstance(value, bool):
        return 0.0
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError):
        return 0.0
    return max(0.0, number) if math.isfinite(number) else 0.0


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        part.get("text", "")
        for part in content
        if isinstance(part, dict)
        and part.get("type") == "text"
        and isinstance(part.get("text"), str)
    )


def _topic(text: str) -> Optional[str]:
    clean = " ".join(text.split())
    lower = clean.lower()
    for prefix in _TOPIC_PREFIXES:
        if lower.startswith(prefix):
            clean = clean[len(prefix):].strip()
            break
    if not clean:
        return None
    return clean[:117] + "..." if len(clean) > 120 else clean


def _parse_timestamp(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return timestamp if timestamp.utcoffset() is not None else None


def _usage(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    cost = value.get("cost")
    cost_total = _safe_float(cost.get("total")) if isinstance(cost, dict) else 0.0
    cache_write = _safe_int(value.get("cacheWrite"))
    cache_write_1h = min(cache_write, _safe_int(value.get("cacheWrite1h")))
    return {
        "input": _safe_int(value.get("input")),
        "output": _safe_int(value.get("output")),
        "cache_read": _safe_int(value.get("cacheRead")),
        "cache_write": cache_write,
        "cache_write_1h": cache_write_1h,
        "cache_write_5m": cache_write - cache_write_1h,
        "cost": cost_total,
    }


def _tool_name(value: Any) -> str:
    name = value if isinstance(value, str) and value else "unknown"
    return _TOOL_ALIASES.get(name, name)


def _tool_calls(message: dict[str, Any]):
    content = message.get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if isinstance(block, dict) and block.get("type") == "toolCall":
            yield block


def _retained_tail(entry: dict[str, Any]) -> list[dict[str, Any]]:
    value = entry.get("retainedTail")
    if not isinstance(value, list):
        return []
    return [message for message in value if isinstance(message, dict)]


def _message_timestamp(message: dict[str, Any], fallback: Any) -> str:
    value = message.get("timestamp")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat().replace(
                "+00:00", "Z"
            )
        except (OSError, OverflowError, ValueError):
            pass
    return fallback if isinstance(fallback, str) else ""


def parse_session_jsonl(filepath: Union[str, Path]) -> Optional[dict[str, Any]]:
    session = _read_session(filepath)
    if session is None:
        return None
    header, records = session
    branch = _active_branch(records)
    if not branch:
        return None

    total_input = 0
    total_output = 0
    total_cache_read = 0
    total_cache_create = 0
    total_cache_create_1h = 0
    total_cache_create_5m = 0
    total_cost = 0.0
    message_count = 0
    api_calls = 0
    model_usage: dict[str, int] = {}
    model_usage_breakdown: dict[str, dict[str, int]] = {}
    tool_counts: dict[str, int] = {}
    skills_used: dict[str, int] = {}
    subagents_used: dict[str, int] = {}
    effort_counts: dict[str, int] = {}
    provider: Optional[str] = None
    model: Optional[str] = None
    topic: Optional[str] = None
    first_ts = _parse_timestamp(header.get("timestamp"))
    last_ts = first_ts
    api_timestamps: list[datetime] = []

    for entry in branch:
        timestamp = _parse_timestamp(entry.get("timestamp"))
        if timestamp is not None:
            first_ts = first_ts or timestamp
            last_ts = timestamp

        entry_type = entry.get("type")
        if entry_type == "model_change":
            if isinstance(entry.get("provider"), str) and entry["provider"]:
                provider = entry["provider"]
            if isinstance(entry.get("modelId"), str) and entry["modelId"]:
                model = entry["modelId"]
        elif entry_type == "thinking_level_change":
            level = entry.get("thinkingLevel")
            if isinstance(level, str) and level:
                effort_counts[level] = effort_counts.get(level, 0) + 1

        message = entry.get("message")
        if isinstance(message, dict):
            role = message.get("role")
            if role == "user":
                message_count += 1
                topic = topic or _topic(_text(message.get("content")))
            elif role == "assistant":
                message_count += 1
                if isinstance(message.get("provider"), str) and message["provider"]:
                    provider = message["provider"]
                if isinstance(message.get("model"), str) and message["model"]:
                    model = message["model"]
                for call in _tool_calls(message):
                    name = _tool_name(call.get("name"))
                    tool_counts[name] = tool_counts.get(name, 0) + 1
                    arguments = call.get("arguments")
                    if not isinstance(arguments, dict):
                        arguments = {}
                    if name == "Skill":
                        skill = str(arguments.get("skill") or "unknown")
                        skills_used[skill] = skills_used.get(skill, 0) + 1
                    elif name in {"Task", "Agent"}:
                        agent = str(arguments.get("subagent_type") or "unknown")
                        subagents_used[agent] = subagents_used.get(agent, 0) + 1

        usage = _usage(message.get("usage") if isinstance(message, dict) else entry.get("usage"))
        if usage is None:
            continue
        api_calls += 1
        total_input += usage["input"] + usage["cache_read"] + usage["cache_write"]
        total_output += usage["output"]
        total_cache_read += usage["cache_read"]
        total_cache_create += usage["cache_write"]
        total_cache_create_1h += usage["cache_write_1h"]
        total_cache_create_5m += usage["cache_write_5m"]
        total_cost += usage["cost"]
        if not math.isfinite(total_cost):
            return None
        if timestamp is not None:
            api_timestamps.append(timestamp)
        model_key = model or "pi"
        model_usage[model_key] = (
            model_usage.get(model_key, 0)
            + usage["input"]
            + usage["cache_write"]
            + usage["output"]
        )
        breakdown = model_usage_breakdown.setdefault(
            model_key,
            {
                "fresh_input": 0,
                "cache_read": 0,
                "cache_create": 0,
                "cache_create_1h": 0,
                "cache_create_5m": 0,
                "output": 0,
            },
        )
        breakdown["fresh_input"] += usage["input"]
        breakdown["cache_read"] += usage["cache_read"]
        breakdown["cache_create"] += usage["cache_write"]
        breakdown["cache_create_1h"] += usage["cache_write_1h"]
        breakdown["cache_create_5m"] += usage["cache_write_5m"]
        breakdown["output"] += usage["output"]

    if message_count == 0 and api_calls == 0:
        return None

    gaps = [
        max(0.0, (later - earlier).total_seconds())
        for earlier, later in zip(api_timestamps, api_timestamps[1:])
    ]
    duration = 0.0
    if first_ts is not None and last_ts is not None:
        duration = max(0.0, (last_ts - first_ts).total_seconds() / 60.0)
    dominant_effort = max(effort_counts, key=effort_counts.get) if effort_counts else None

    return {
        "version": header.get("version"),
        "slug": header.get("id"),
        "topic": topic,
        "duration_minutes": duration,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "total_cache_read": total_cache_read,
        "total_cache_create": total_cache_create,
        "total_cache_create_1h": total_cache_create_1h,
        "total_cache_create_5m": total_cache_create_5m,
        "model_context_window": None,
        "cache_hit_rate": total_cache_read / total_input if total_input else 0.0,
        "avg_call_gap_seconds": sum(gaps) / len(gaps) if gaps else None,
        "max_call_gap_seconds": max(gaps) if gaps else None,
        "p95_call_gap_seconds": None,
        "cost_usd": round(total_cost, 6),
        "cost_source": "pi_usage",
        "provider": provider,
        "model": model,
        "model_usage": model_usage,
        "model_usage_breakdown": model_usage_breakdown,
        "reported_input_tokens": sum(parts["fresh_input"] for parts in model_usage_breakdown.values()),
        "reported_output_tokens": total_output,
        "reported_model_usage": {
            model_key: parts["fresh_input"] + parts["output"]
            for model_key, parts in model_usage_breakdown.items()
        },
        "skills_used": skills_used,
        "subagents_used": subagents_used,
        "tool_calls": tool_counts,
        "message_count": message_count,
        "api_calls": api_calls,
        "first_ts": first_ts.isoformat() if first_ts else None,
        "is_sidechain": False,
        "sidechain_reason": None,
        "estimated": False,
        "runtime": "pi",
        "token_source": "pi_usage",
        "rate_limits": None,
        "effort": dominant_effort,
        "effort_breakdown": effort_counts,
        "tool_duration_p90_ms": None,
        "task_duration_ms_max": None,
        "ttft_ms_avg": None,
    }


def parse_session_turns(filepath: Union[str, Path]) -> list[dict[str, Any]]:
    branch = active_entries(filepath)
    turns: list[dict[str, Any]] = []
    current_model: Optional[str] = None
    current_provider: Optional[str] = None
    previous_timestamp: Optional[datetime] = None

    for entry in branch:
        if entry.get("type") == "model_change":
            provider = entry.get("provider")
            model = entry.get("modelId")
            if isinstance(provider, str) and provider:
                current_provider = provider
            if isinstance(model, str) and model:
                current_model = model
            continue

        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        usage = _usage(message.get("usage"))
        if usage is None:
            continue

        provider = message.get("provider")
        model = message.get("model")
        if isinstance(provider, str) and provider:
            current_provider = provider
        if isinstance(model, str) and model:
            current_model = model
        timestamp_value = entry.get("timestamp")
        timestamp = _parse_timestamp(timestamp_value)
        gap = None
        if timestamp is not None:
            if previous_timestamp is not None:
                gap = int(round(max(0.0, (timestamp - previous_timestamp).total_seconds())))
            previous_timestamp = timestamp

        turns.append({
            "turn_index": len(turns),
            "role": "assistant",
            "input_tokens": usage["input"] + usage["cache_read"],
            "output_tokens": usage["output"],
            "cache_read": usage["cache_read"],
            "cache_creation": usage["cache_write"],
            "cache_creation_1h": usage["cache_write_1h"],
            "cache_creation_5m": usage["cache_write_5m"],
            "model": current_model or "pi",
            "provider": current_provider,
            "timestamp": timestamp_value if timestamp is not None else None,
            "gap_since_prev_seconds": gap,
            "tools_used": [
                _tool_name(call.get("name"))
                for call in _tool_calls(message)
            ],
            "cost_usd": round(usage["cost"], 6),
            "cost_source": "pi_usage",
            "estimated": False,
        })

    return turns


def parse_jsonl_for_quality(filepath: Union[str, Path]) -> Optional[dict[str, Any]]:
    branch = active_entries(filepath)
    if not branch:
        return None

    reads: list[tuple[int, str, str]] = []
    writes: list[tuple[int, str, str]] = []
    tool_results: list[tuple[int, str, int, bool]] = []
    tool_result_meta: list[dict[str, Any]] = []
    system_reminders: list[tuple[int, str, int]] = []
    messages: list[tuple[int, str, int, bool]] = []
    agent_dispatches: list[tuple[int, int, int]] = []
    decisions: list[tuple[int, str]] = []
    compaction_ratios: list[dict[str, Any]] = []
    tool_name_by_id: dict[str, str] = {}
    topic: Optional[str] = None
    current_model: Optional[str] = None
    context_tokens: Optional[int] = None
    compactions = 0
    tool_call_count = 0
    idx = 0

    def process_message(message: dict[str, Any], timestamp: str) -> None:
        nonlocal topic, current_model, context_tokens, tool_call_count, idx
        role = message.get("role")
        text = _text(message.get("content"))
        if role == "user":
            topic = topic or _topic(text)
            messages.append((idx, "user", len(text), len(text.split()) > 10))
        elif role == "assistant":
            model = message.get("model")
            if isinstance(model, str) and model:
                current_model = model
            usage = _usage(message.get("usage"))
            if usage is not None:
                context_tokens = usage["input"] + usage["cache_read"] + usage["cache_write"]

            substantive = len(text.split()) > 20
            if _DECISION_RE.search(text):
                decisions.append((idx, text[:200].strip()))
            for call in _tool_calls(message):
                substantive = True
                tool_call_count += 1
                call_id = call.get("id")
                name = _tool_name(call.get("name"))
                if isinstance(call_id, str) and call_id:
                    tool_name_by_id[call_id] = name
                arguments = call.get("arguments")
                if not isinstance(arguments, dict):
                    arguments = {}
                path = arguments.get("file_path") or arguments.get("path")
                if name == "Read" and isinstance(path, str) and path:
                    reads.append((idx, path, timestamp))
                elif name in {"Edit", "Write"} and isinstance(path, str) and path:
                    writes.append((idx, path, timestamp))
                elif name in {"Task", "Agent"}:
                    prompt = arguments.get("prompt") or arguments.get("message") or ""
                    agent_dispatches.append((idx, len(prompt) if isinstance(prompt, str) else 0, 0))
            messages.append((idx, "assistant", len(text), substantive))
        elif role == "toolResult":
            output = _text(message.get("content"))
            call_id = message.get("toolCallId")
            call_id = call_id if isinstance(call_id, str) and call_id else str(idx)
            failed = bool(message.get("isError")) or bool(_ERROR_RE.search(output))
            tool_results.append((idx, call_id, len(output), False))
            tool_result_meta.append({
                "index": idx,
                "tool_id": call_id,
                "tool_name": tool_name_by_id.get(
                    call_id, _tool_name(message.get("toolName"))
                ),
                "size": len(output),
                "is_failure": failed,
            })
            if agent_dispatches and agent_dispatches[-1][2] == 0:
                dispatch = agent_dispatches[-1]
                agent_dispatches[-1] = (dispatch[0], dispatch[1], len(output))
        idx += 1

    latest_compaction = max(
        (index for index, entry in enumerate(branch) if entry.get("type") == "compaction"),
        default=-1,
    )
    persisted_model: Optional[str] = None
    post_compaction_model: Optional[str] = None
    for branch_index, entry in enumerate(branch):
        entry_type = entry.get("type")
        if entry_type == "compaction":
            compactions += 1
            retained = _retained_tail(entry)
            after_chars = sum(len(_text(message.get("content"))) for message in retained)
            after_tokens = after_chars // 4 if after_chars else None
            before_tokens = _safe_int(entry.get("tokensBefore")) or None
            compaction_ratios.append({
                "before_context_tokens": before_tokens,
                "after_context_tokens": after_tokens,
                "replacement_msgs": len(retained) if isinstance(entry.get("retainedTail"), list) else None,
                "ratio": round(after_tokens / before_tokens, 3)
                if after_tokens and before_tokens
                else None,
            })
        elif entry_type == "custom_message" and branch_index > latest_compaction:
            content = _text(entry.get("content"))
            if "system-reminder" in content:
                digest = hashlib.sha256(content.encode()).hexdigest()[:16]
                system_reminders.append((branch_index, digest, len(content)))

        model = entry.get("modelId") if entry_type == "model_change" else None
        message = entry.get("message")
        if isinstance(message, dict) and message.get("role") == "assistant":
            model = message.get("model")
        if isinstance(model, str) and model:
            persisted_model = model
            if branch_index > latest_compaction:
                post_compaction_model = model

    for message, timestamp in _materialized_messages(branch):
        process_message(message, timestamp)
    current_model = post_compaction_model or current_model or persisted_model

    if not messages:
        return None
    return {
        "reads": reads,
        "writes": writes,
        "tool_results": tool_results,
        "tool_result_meta": tool_result_meta,
        "system_reminders": system_reminders,
        "messages": messages,
        "compactions": compactions,
        "tool_calls": tool_call_count,
        "agent_dispatches": agent_dispatches,
        "decisions": decisions,
        "compaction_ratios": compaction_ratios,
        "total_entries": idx,
        "estimated": False,
        "context_tokens": context_tokens,
        "model_context_window": None,
        "model": current_model or "pi",
        "topic": topic,
    }


def _materialized_messages(
    branch: list[dict[str, Any]],
) -> list[tuple[dict[str, Any], str]]:
    materialized: list[tuple[dict[str, Any], str]] = []
    positions = {
        entry.get("id"): index
        for index, entry in enumerate(branch)
        if isinstance(entry.get("id"), str)
    }
    for index, entry in enumerate(branch):
        timestamp = entry.get("timestamp")
        timestamp = timestamp if isinstance(timestamp, str) else ""
        if entry.get("type") == "compaction":
            if "retainedTail" in entry:
                materialized = [
                    (message, _message_timestamp(message, timestamp))
                    for message in _retained_tail(entry)
                ]
            else:
                first_kept = entry.get("firstKeptEntryId")
                start = positions.get(first_kept) if isinstance(first_kept, str) else None
                materialized = []
                if start is not None and start < index:
                    for kept in branch[start:index]:
                        message = kept.get("message")
                        kept_timestamp = kept.get("timestamp")
                        if isinstance(message, dict):
                            materialized.append((
                                message,
                                kept_timestamp if isinstance(kept_timestamp, str) else "",
                            ))
            continue
        message = entry.get("message")
        if isinstance(message, dict):
            materialized.append((message, timestamp))
    return materialized


def _append_state_file(
    path: str,
    action: str,
    line_range: str,
    active_files: list[tuple[str, str, str]],
    recent_reads: list[str],
    seen_files: set[str],
    max_files: int,
) -> None:
    if not path:
        return
    if path in seen_files:
        if action == "modified" and all(item[0] != path for item in active_files):
            if len(active_files) < max_files:
                active_files.append((path, action, line_range))
            if path in recent_reads:
                recent_reads.remove(path)
        return
    seen_files.add(path)
    if action == "modified":
        if len(active_files) < max_files:
            active_files.append((path, action, line_range))
    else:
        recent_reads.append(path)


def _state_snippets(text: str, pattern: re.Pattern[str]) -> list[str]:
    snippets = []
    for sentence in re.findall(r"[^.!?\n]+(?:[.!?]|$)", text):
        clean = sentence.strip().rstrip(".!")[:200]
        if clean and pattern.search(clean):
            snippets.append(clean)
    return snippets


def extract_session_state(
    filepath: Union[str, Path],
    tail_lines: int = 500,
    max_files: int = 20,
) -> Optional[dict[str, Any]]:
    if (
        not isinstance(tail_lines, int)
        or isinstance(tail_lines, bool)
        or tail_lines <= 0
        or not isinstance(max_files, int)
        or isinstance(max_files, bool)
        or max_files <= 0
    ):
        return None
    messages = _materialized_messages(active_entries(filepath))[-tail_lines:]
    if not messages:
        return None

    active_files: list[tuple[str, str, str]] = []
    recent_reads: list[str] = []
    decisions: list[str] = []
    open_questions: list[str] = []
    agent_state: list[tuple[str, str]] = []
    error_context: list[tuple[str, str]] = []
    todos: list[tuple[str, str]] = []
    active_plan: Optional[str] = None
    last_user = ""
    last_assistant = ""
    seen_files: set[str] = set()
    recent_errors: list[str] = []
    question_re = re.compile(r"\?|\b(?:TODO|FIXME|HACK|XXX)\b", re.IGNORECASE)

    for message, _timestamp in messages:
        role = message.get("role")
        text = _text(message.get("content")).strip()
        if role == "user":
            if text:
                last_user = text
                for snippet in _state_snippets(text, question_re):
                    if snippet not in open_questions:
                        open_questions.append(snippet)
            continue
        if role == "toolResult":
            if message.get("isError") or _ERROR_RE.search(text):
                recent_errors.append(text[:300])
            continue
        if role != "assistant":
            continue

        if text:
            last_assistant = text
            for snippet in _state_snippets(text, _DECISION_RE):
                if snippet not in decisions:
                    decisions.append(snippet)
            for snippet in _state_snippets(text, question_re):
                if snippet not in open_questions:
                    open_questions.append(snippet)
            if recent_errors and re.search(
                r"\b(fix|fixed|instead|switched|resolved|retry|rerun|passing)\b",
                text,
                re.IGNORECASE,
            ):
                error_context.append((recent_errors[-1][:200], text[:200]))
                recent_errors = []
            if _ERROR_RE.search(text):
                recent_errors.append(text[:300])

        for call in _tool_calls(message):
            name = _tool_name(call.get("name"))
            arguments = call.get("arguments")
            if not isinstance(arguments, dict):
                arguments = {}
            path = arguments.get("file_path") or arguments.get("path")
            if name in {"Read", "Edit", "Write"} and isinstance(path, str) and path:
                action = "read" if name == "Read" else "modified"
                line_range = ""
                offset = arguments.get("offset")
                limit = arguments.get("limit")
                if isinstance(offset, int) and not isinstance(offset, bool) and offset > 0:
                    line_range = f"line {offset}"
                    if isinstance(limit, int) and not isinstance(limit, bool) and limit > 0:
                        line_range += f"-{offset + limit}"
                _append_state_file(
                    path,
                    action,
                    line_range,
                    active_files,
                    recent_reads,
                    seen_files,
                    max_files,
                )
                if "/docs/plans/" in f"/{path}" and path.endswith(".md"):
                    active_plan = path
            elif name in {"Task", "Agent"}:
                agent_type = arguments.get("subagent_type") or arguments.get("description")
                description = arguments.get("description") or arguments.get("prompt") or ""
                agent_state.append((
                    agent_type if isinstance(agent_type, str) and agent_type else "unknown",
                    description[:100] if isinstance(description, str) else "",
                ))
            elif name == "TodoWrite":
                value = arguments.get("todos")
                if isinstance(value, list):
                    todos = [
                        (
                            str(item.get("content") or item.get("step") or "")[:120],
                            str(item.get("status") or ""),
                        )
                        for item in value
                        if isinstance(item, dict) and (item.get("content") or item.get("step"))
                    ]

    return {
        "active_files": active_files[-max_files:],
        "recent_reads": recent_reads[-max_files:],
        "decisions": decisions[-10:],
        "open_questions": open_questions[-5:],
        "agent_state": agent_state[-10:],
        "error_context": error_context[-5:],
        "todos": todos,
        "active_plan": active_plan,
        "current_step": {
            "last_user": last_user[:500],
            "last_assistant": last_assistant[:500],
        },
    }


def iter_tool_outputs(
    filepath: Union[str, Path],
    *,
    min_chars: int = 4096,
    max_outputs: int = 20,
) -> list[dict[str, Any]]:
    if (
        not isinstance(min_chars, int)
        or isinstance(min_chars, bool)
        or min_chars < 0
        or not isinstance(max_outputs, int)
        or isinstance(max_outputs, bool)
        or max_outputs <= 0
    ):
        return []

    call_meta: dict[str, dict[str, str]] = {}
    outputs: deque[dict[str, Any]] = deque(maxlen=max_outputs)
    for index, (message, timestamp) in enumerate(
        _materialized_messages(active_entries(filepath))
    ):
        if message.get("role") == "assistant":
            for call in _tool_calls(message):
                call_id = call.get("id")
                if not isinstance(call_id, str) or not call_id:
                    call_id = str(index)
                raw_name = call.get("name")
                raw_name = raw_name if isinstance(raw_name, str) and raw_name else "unknown"
                name = _tool_name(raw_name)
                arguments = call.get("arguments")
                if not isinstance(arguments, dict):
                    arguments = {}
                command_or_path = ""
                if name == "Bash":
                    value = arguments.get("command") or arguments.get("cmd")
                    command_or_path = value if isinstance(value, str) else ""
                elif name in {"Read", "Edit", "Write"}:
                    value = arguments.get("file_path") or arguments.get("path")
                    command_or_path = value if isinstance(value, str) else ""
                call_meta[call_id] = {
                    "tool_name": name,
                    "tool_type": raw_name,
                    "command_or_path": command_or_path,
                }
            continue
        if message.get("role") != "toolResult":
            continue
        output = _text(message.get("content"))
        call_id = message.get("toolCallId")
        call_id = call_id if isinstance(call_id, str) and call_id else str(index)
        if len(output) < min_chars and not message.get("isError") and not _ERROR_RE.search(output):
            continue
        meta = call_meta.get(call_id, {})
        raw_tool = message.get("toolName")
        outputs.append({
            "tool_use_id": call_id,
            "tool_name": meta.get("tool_name", _tool_name(raw_tool)),
            "tool_type": meta.get(
                "tool_type",
                raw_tool if isinstance(raw_tool, str) and raw_tool else "toolResult",
            ),
            "command_or_path": meta.get("command_or_path", ""),
            "output": output,
            "timestamp": timestamp or None,
        })
    return list(outputs)
