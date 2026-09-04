#!/usr/bin/env python3
"""Read-only Pi v3 session adapter for Token Optimizer."""

from __future__ import annotations

import hashlib
import heapq
import json
import math
import os
import re
from collections import Counter, deque
from datetime import datetime, timezone
from itertools import pairwise
from pathlib import Path
from typing import Any, TypeGuard

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


def _nonempty(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _positive_int(value: Any) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _session_header(line: str) -> dict[str, Any] | None:
    """Parse a JSONL first line and return it only when it is a v3 session header."""
    if len(line) > MAX_JSONL_LINE_CHARS:
        return None
    header = _loads_json(line)
    if (
        not isinstance(header, dict)
        or header.get("type") != "session"
        or header.get("version") != 3
    ):
        return None
    return header


def _read_header(filepath: str | Path) -> dict[str, Any] | None:
    path = Path(filepath).expanduser()
    try:
        if path.suffix != ".jsonl" or path.is_symlink() or not path.is_file():
            return None
        if path.stat().st_size > MAX_PARSE_FILE_BYTES:
            return None
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            return _session_header(handle.readline(MAX_JSONL_LINE_CHARS + 1))
    except (OSError, json.JSONDecodeError, ValueError):
        return None


def is_pi_session_path(path: str | Path) -> bool:
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


def find_current_session_jsonl() -> Path | None:
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


def _iter_valid_session_files(cutoff: float | None = None):
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
    if not (_positive_int(days) or days == 0) or not _positive_int(max_files):
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


def find_session_jsonl_by_id(session_id: str) -> Path | None:
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


def _read_session(
    filepath: str | Path,
) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
    path = Path(filepath).expanduser()
    if not is_pi_session_path(path):
        return None
    try:
        if path.stat().st_size > MAX_PARSE_FILE_BYTES:
            return None
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            header = _session_header(handle.readline(MAX_JSONL_LINE_CHARS + 1))
            if header is None:
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


def active_entries(filepath: str | Path) -> list[dict[str, Any]]:
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


def _topic(text: str) -> str | None:
    clean = " ".join(text.split())
    lower = clean.lower()
    for prefix in _TOPIC_PREFIXES:
        if lower.startswith(prefix):
            clean = clean[len(prefix) :].strip()
            break
    if not clean:
        return None
    return clean[:117] + "..." if len(clean) > 120 else clean


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return timestamp if timestamp.utcoffset() is not None else None


_USAGE_TOKEN_KEYS = (
    "fresh_input",
    "cache_read",
    "cache_create",
    "cache_create_1h",
    "cache_create_5m",
    "output",
)


def _usage(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    cost = value.get("cost")
    cost_total = _safe_float(cost.get("total")) if isinstance(cost, dict) else 0.0
    cache_create = _safe_int(value.get("cacheWrite"))
    cache_create_1h = min(cache_create, _safe_int(value.get("cacheWrite1h")))
    return {
        "fresh_input": _safe_int(value.get("input")),
        "output": _safe_int(value.get("output")),
        "cache_read": _safe_int(value.get("cacheRead")),
        "cache_create": cache_create,
        "cache_create_1h": cache_create_1h,
        "cache_create_5m": cache_create - cache_create_1h,
        "cost": cost_total,
    }


def _tool_name(value: Any) -> str:
    name = _nonempty(value) or "unknown"
    return _TOOL_ALIASES.get(name, name)


def _tool_calls(message: dict[str, Any]):
    content = message.get("content")
    if not isinstance(content, list):
        return
    for block in content:
        if isinstance(block, dict) and block.get("type") == "toolCall":
            yield block


def _call_arguments(call: dict[str, Any]) -> dict[str, Any]:
    arguments = call.get("arguments")
    return arguments if isinstance(arguments, dict) else {}


def _call_path(arguments: dict[str, Any]) -> str | None:
    return _nonempty(arguments.get("file_path") or arguments.get("path"))


def _retained_tail(entry: dict[str, Any]) -> list[dict[str, Any]]:
    value = entry.get("retainedTail")
    if not isinstance(value, list):
        return []
    return [message for message in value if isinstance(message, dict)]


def _message_timestamp(message: dict[str, Any], fallback: Any) -> str:
    value = message.get("timestamp")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return (
                datetime.fromtimestamp(value / 1000, tz=timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
        except (OSError, OverflowError, ValueError):
            pass
    return fallback if isinstance(fallback, str) else ""


def parse_session_jsonl(filepath: str | Path) -> dict[str, Any] | None:
    session = _read_session(filepath)
    if session is None:
        return None
    header, records = session
    branch = _active_branch(records)
    if not branch:
        return None

    total_cost = 0.0
    message_count = 0
    api_calls = 0
    model_usage_breakdown: dict[str, dict[str, int]] = {}
    tool_counts: Counter[str] = Counter()
    skills_used: Counter[str] = Counter()
    subagents_used: Counter[str] = Counter()
    effort_counts: Counter[str] = Counter()
    provider: str | None = None
    model: str | None = None
    topic: str | None = None
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
            provider = _nonempty(entry.get("provider")) or provider
            model = _nonempty(entry.get("modelId")) or model
        elif entry_type == "thinking_level_change":
            level = _nonempty(entry.get("thinkingLevel"))
            if level:
                effort_counts[level] += 1

        message = entry.get("message")
        if isinstance(message, dict):
            role = message.get("role")
            if role == "user":
                message_count += 1
                topic = topic or _topic(_text(message.get("content")))
            elif role == "assistant":
                message_count += 1
                provider = _nonempty(message.get("provider")) or provider
                model = _nonempty(message.get("model")) or model
                for call in _tool_calls(message):
                    name = _tool_name(call.get("name"))
                    tool_counts[name] += 1
                    arguments = _call_arguments(call)
                    if name == "Skill":
                        skills_used[str(arguments.get("skill") or "unknown")] += 1
                    elif name in {"Task", "Agent"}:
                        agent = str(arguments.get("subagent_type") or "unknown")
                        subagents_used[agent] += 1

        usage = _usage(
            message.get("usage") if isinstance(message, dict) else entry.get("usage")
        )
        if usage is None:
            continue
        api_calls += 1
        total_cost += usage["cost"]
        if timestamp is not None:
            api_timestamps.append(timestamp)
        breakdown = model_usage_breakdown.setdefault(
            model or "pi", dict.fromkeys(_USAGE_TOKEN_KEYS, 0)
        )
        for key in _USAGE_TOKEN_KEYS:
            breakdown[key] += usage[key]

    if (message_count == 0 and api_calls == 0) or not math.isfinite(total_cost):
        return None

    def total(key: str) -> int:
        return sum(parts[key] for parts in model_usage_breakdown.values())

    total_cache_read = total("cache_read")
    total_cache_create = total("cache_create")
    total_input = total("fresh_input") + total_cache_read + total_cache_create
    total_output = total("output")
    gaps = [
        max(0.0, (later - earlier).total_seconds())
        for earlier, later in pairwise(api_timestamps)
    ]
    duration = 0.0
    if first_ts is not None and last_ts is not None:
        duration = max(0.0, (last_ts - first_ts).total_seconds() / 60.0)
    dominant_effort = effort_counts.most_common(1)[0][0] if effort_counts else None

    return {
        "version": header.get("version"),
        "slug": header.get("id"),
        "topic": topic,
        "duration_minutes": duration,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "total_cache_read": total_cache_read,
        "total_cache_create": total_cache_create,
        "total_cache_create_1h": total("cache_create_1h"),
        "total_cache_create_5m": total("cache_create_5m"),
        "model_context_window": None,
        "cache_hit_rate": total_cache_read / total_input if total_input else 0.0,
        "avg_call_gap_seconds": sum(gaps) / len(gaps) if gaps else None,
        "max_call_gap_seconds": max(gaps) if gaps else None,
        "p95_call_gap_seconds": None,
        "cost_usd": round(total_cost, 6),
        "cost_source": "pi_usage",
        "provider": provider,
        "model": model,
        "model_usage": {
            model_key: parts["fresh_input"] + parts["cache_create"] + parts["output"]
            for model_key, parts in model_usage_breakdown.items()
        },
        "model_usage_breakdown": model_usage_breakdown,
        "reported_input_tokens": total("fresh_input"),
        "reported_output_tokens": total_output,
        "reported_model_usage": {
            model_key: parts["fresh_input"] + parts["output"]
            for model_key, parts in model_usage_breakdown.items()
        },
        "skills_used": dict(skills_used),
        "subagents_used": dict(subagents_used),
        "tool_calls": dict(tool_counts),
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
        "effort_breakdown": dict(effort_counts),
        "tool_duration_p90_ms": None,
        "task_duration_ms_max": None,
        "ttft_ms_avg": None,
    }


def parse_session_turns(filepath: str | Path) -> list[dict[str, Any]]:
    branch = active_entries(filepath)
    turns: list[dict[str, Any]] = []
    current_model: str | None = None
    current_provider: str | None = None
    previous_timestamp: datetime | None = None

    for entry in branch:
        if entry.get("type") == "model_change":
            current_provider = _nonempty(entry.get("provider")) or current_provider
            current_model = _nonempty(entry.get("modelId")) or current_model
            continue

        message = entry.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        usage = _usage(message.get("usage"))
        if usage is None:
            continue

        current_provider = _nonempty(message.get("provider")) or current_provider
        current_model = _nonempty(message.get("model")) or current_model
        timestamp_value = entry.get("timestamp")
        timestamp = _parse_timestamp(timestamp_value)
        gap = None
        if timestamp is not None:
            if previous_timestamp is not None:
                gap = round(max(0.0, (timestamp - previous_timestamp).total_seconds()))
            previous_timestamp = timestamp

        turns.append(
            {
                "turn_index": len(turns),
                "role": "assistant",
                "input_tokens": usage["fresh_input"] + usage["cache_read"],
                "output_tokens": usage["output"],
                "cache_read": usage["cache_read"],
                "cache_creation": usage["cache_create"],
                "cache_creation_1h": usage["cache_create_1h"],
                "cache_creation_5m": usage["cache_create_5m"],
                "model": current_model or "pi",
                "provider": current_provider,
                "timestamp": timestamp_value if timestamp is not None else None,
                "gap_since_prev_seconds": gap,
                "tools_used": [
                    _tool_name(call.get("name")) for call in _tool_calls(message)
                ],
                "cost_usd": round(usage["cost"], 6),
                "cost_source": "pi_usage",
                "estimated": False,
            }
        )

    return turns


def parse_jsonl_for_quality(filepath: str | Path) -> dict[str, Any] | None:
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
    topic: str | None = None
    context_tokens: int | None = None
    compactions = 0
    tool_call_count = 0

    latest_compaction = max(
        (
            index
            for index, entry in enumerate(branch)
            if entry.get("type") == "compaction"
        ),
        default=-1,
    )
    persisted_model: str | None = None
    post_compaction_model: str | None = None
    for branch_index, entry in enumerate(branch):
        entry_type = entry.get("type")
        if entry_type == "compaction":
            compactions += 1
            retained = _retained_tail(entry)
            after_chars = sum(
                len(_text(message.get("content"))) for message in retained
            )
            after_tokens = after_chars // 4 if after_chars else None
            before_tokens = _safe_int(entry.get("tokensBefore")) or None
            compaction_ratios.append(
                {
                    "before_context_tokens": before_tokens,
                    "after_context_tokens": after_tokens,
                    "replacement_msgs": len(retained)
                    if isinstance(entry.get("retainedTail"), list)
                    else None,
                    "ratio": round(after_tokens / before_tokens, 3)
                    if after_tokens and before_tokens
                    else None,
                }
            )
        elif entry_type == "custom_message" and branch_index > latest_compaction:
            content = _text(entry.get("content"))
            if "system-reminder" in content:
                digest = hashlib.sha256(content.encode()).hexdigest()[:16]
                system_reminders.append((branch_index, digest, len(content)))

        model = entry.get("modelId") if entry_type == "model_change" else None
        message = entry.get("message")
        if isinstance(message, dict) and message.get("role") == "assistant":
            model = message.get("model")
        model = _nonempty(model)
        if model:
            persisted_model = model
            if branch_index > latest_compaction:
                post_compaction_model = model

    materialized = _materialized_messages(branch)
    current_model: str | None = None
    for idx, (message, timestamp) in enumerate(materialized):
        role = message.get("role")
        text = _text(message.get("content"))
        if role == "user":
            topic = topic or _topic(text)
            messages.append((idx, "user", len(text), len(text.split()) > 10))
        elif role == "assistant":
            current_model = _nonempty(message.get("model")) or current_model
            usage = _usage(message.get("usage"))
            if usage is not None:
                context_tokens = (
                    usage["fresh_input"] + usage["cache_read"] + usage["cache_create"]
                )

            substantive = len(text.split()) > 20
            if _DECISION_RE.search(text):
                decisions.append((idx, text[:200].strip()))
            for call in _tool_calls(message):
                substantive = True
                tool_call_count += 1
                call_id = _nonempty(call.get("id"))
                name = _tool_name(call.get("name"))
                if call_id:
                    tool_name_by_id[call_id] = name
                arguments = _call_arguments(call)
                path = _call_path(arguments)
                if name == "Read" and path:
                    reads.append((idx, path, timestamp))
                elif name in {"Edit", "Write"} and path:
                    writes.append((idx, path, timestamp))
                elif name in {"Task", "Agent"}:
                    prompt = arguments.get("prompt") or arguments.get("message") or ""
                    agent_dispatches.append(
                        (idx, len(prompt) if isinstance(prompt, str) else 0, 0)
                    )
            messages.append((idx, "assistant", len(text), substantive))
        elif role == "toolResult":
            call_id = _nonempty(message.get("toolCallId")) or str(idx)
            failed = bool(message.get("isError")) or bool(_ERROR_RE.search(text))
            tool_results.append((idx, call_id, len(text), False))
            tool_result_meta.append(
                {
                    "index": idx,
                    "tool_id": call_id,
                    "tool_name": tool_name_by_id.get(
                        call_id, _tool_name(message.get("toolName"))
                    ),
                    "size": len(text),
                    "is_failure": failed,
                }
            )
            if agent_dispatches and agent_dispatches[-1][2] == 0:
                dispatch = agent_dispatches[-1]
                agent_dispatches[-1] = (dispatch[0], dispatch[1], len(text))
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
        "total_entries": len(materialized),
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
        timestamp = _nonempty(entry.get("timestamp")) or ""
        if entry.get("type") == "compaction":
            if "retainedTail" in entry:
                materialized = [
                    (message, _message_timestamp(message, timestamp))
                    for message in _retained_tail(entry)
                ]
            else:
                first_kept = entry.get("firstKeptEntryId")
                start = (
                    positions.get(first_kept) if isinstance(first_kept, str) else None
                )
                materialized = []
                if start is not None and start < index:
                    materialized = [
                        (kept["message"], _nonempty(kept.get("timestamp")) or "")
                        for kept in branch[start:index]
                        if isinstance(kept.get("message"), dict)
                    ]
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
    first_seen = path not in seen_files
    seen_files.add(path)
    if action != "modified":
        if first_seen:
            recent_reads.append(path)
        return
    if all(item[0] != path for item in active_files):
        if len(active_files) < max_files:
            active_files.append((path, action, line_range))
        if path in recent_reads:
            recent_reads.remove(path)


def _state_snippets(text: str, pattern: re.Pattern[str]) -> list[str]:
    snippets = []
    for sentence in re.findall(r"[^.!?\n]+(?:[.!?]|$)", text):
        clean = sentence.strip().rstrip(".!")[:200]
        if clean and pattern.search(clean):
            snippets.append(clean)
    return snippets


def extract_session_state(
    filepath: str | Path,
    tail_lines: int = 500,
    max_files: int = 20,
) -> dict[str, Any] | None:
    if not _positive_int(tail_lines) or not _positive_int(max_files):
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
    active_plan: str | None = None
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
            arguments = _call_arguments(call)
            path = _call_path(arguments)
            if name in {"Read", "Edit", "Write"} and path:
                action = "read" if name == "Read" else "modified"
                line_range = ""
                offset = arguments.get("offset")
                limit = arguments.get("limit")
                if _positive_int(offset):
                    line_range = f"line {offset}"
                    if _positive_int(limit):
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
                agent_type = arguments.get("subagent_type") or arguments.get(
                    "description"
                )
                description = (
                    arguments.get("description") or arguments.get("prompt") or ""
                )
                agent_state.append(
                    (
                        _nonempty(agent_type) or "unknown",
                        description[:100] if isinstance(description, str) else "",
                    )
                )
            elif name == "TodoWrite":
                value = arguments.get("todos")
                if isinstance(value, list):
                    todos = [
                        (
                            str(item.get("content") or item.get("step") or "")[:120],
                            str(item.get("status") or ""),
                        )
                        for item in value
                        if isinstance(item, dict)
                        and (item.get("content") or item.get("step"))
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
    filepath: str | Path,
    *,
    min_chars: int = 4096,
    max_outputs: int = 20,
) -> list[dict[str, Any]]:
    if not (_positive_int(min_chars) or min_chars == 0) or not _positive_int(
        max_outputs
    ):
        return []

    call_meta: dict[str, dict[str, str]] = {}
    outputs: deque[dict[str, Any]] = deque(maxlen=max_outputs)
    for index, (message, timestamp) in enumerate(
        _materialized_messages(active_entries(filepath))
    ):
        if message.get("role") == "assistant":
            for call in _tool_calls(message):
                call_id = _nonempty(call.get("id")) or str(index)
                raw_name = _nonempty(call.get("name")) or "unknown"
                name = _tool_name(raw_name)
                arguments = _call_arguments(call)
                command_or_path = ""
                if name == "Bash":
                    value = arguments.get("command") or arguments.get("cmd")
                    command_or_path = value if isinstance(value, str) else ""
                elif name in {"Read", "Edit", "Write"}:
                    command_or_path = _call_path(arguments) or ""
                call_meta[call_id] = {
                    "tool_name": name,
                    "tool_type": raw_name,
                    "command_or_path": command_or_path,
                }
            continue
        if message.get("role") != "toolResult":
            continue
        output = _text(message.get("content"))
        call_id = _nonempty(message.get("toolCallId")) or str(index)
        if (
            len(output) < min_chars
            and not message.get("isError")
            and not _ERROR_RE.search(output)
        ):
            continue
        meta = call_meta.get(call_id, {})
        raw_tool = message.get("toolName")
        outputs.append(
            {
                "tool_use_id": call_id,
                "tool_name": meta.get("tool_name", _tool_name(raw_tool)),
                "tool_type": meta.get("tool_type", _nonempty(raw_tool) or "toolResult"),
                "command_or_path": meta.get("command_or_path", ""),
                "output": output,
                "timestamp": timestamp or None,
            }
        )
    return list(outputs)
