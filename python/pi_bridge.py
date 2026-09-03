#!/usr/bin/env python3
"""Versioned, one-shot protocol boundary for the Pi Token Optimizer."""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from datetime import datetime
import io
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
from typing import Dict, Optional, TextIO, Tuple


PROTOCOL_VERSION = 1
MAX_ID_LENGTH = 128
MAX_DESCRIPTOR_STRING_BYTES = 4 * 1024
MAX_TEXT_BYTES = 5 * 1024 * 1024
MAX_REQUEST_BYTES = int(5.5 * 1024 * 1024)
MAX_RESPONSE_BYTES = 64 * 1024
MAX_EXPANSION_LINES = 2_000
MAX_CONFIG_BYTES = 64 * 1024
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_JSON_NUMBER_LENGTH = 128
UPSTREAM_VERSION = "5.13.4"
UPSTREAM_COMMIT = "eda65d61b4750b530a6f9956193d4e4632aca0cb"

ACTIONS = frozenset({
    "status",
    "doctor",
    "pre_tool",
    "post_tool",
    "before_prompt",
    "session_start",
    "pre_compact",
    "post_compact",
    "rollup",
    "finalize",
    "dashboard",
    "expand",
})
REQUEST_KEYS = frozenset({"protocolVersion", "action", "session", "tool", "args"})
SESSION_KEYS = frozenset({"id", "cwd", "file", "provider", "model", "reasoningLevel"})
TOOL_KEYS = frozenset({"id", "name", "kind", "input"})
ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
ISO_DATE_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"
)

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = PACKAGE_ROOT / "vendor" / "manifest.json"
PATCH_PATH = PACKAGE_ROOT / "patches" / "pi-runtime.patch"
PARSER_PATH = PACKAGE_ROOT / "python" / "pi_session.py"
SCRIPTS_PATH = (
    PACKAGE_ROOT
    / "vendor"
    / "token-optimizer"
    / "skills"
    / "token-optimizer"
    / "scripts"
)
RUNTIME_PATH = SCRIPTS_PATH / "runtime_env.py"
MEASURE_PATH = SCRIPTS_PATH / "measure.py"

ENGINE_TOOL_NAMES = {
    "bash": "Bash",
    "read": "Read",
    "grep": "Grep",
    "find": "Glob",
    "ls": "Glob",
    "edit": "Edit",
    "write": "Write",
}
MAX_DIAGNOSTIC_CHARS = 512
MAX_ARCHIVE_ENTRY_BYTES = 6 * MAX_TEXT_BYTES + 256 * 1024
MAX_ARCHIVE_MANIFEST_BYTES = 5 * 1024 * 1024
MAX_CONTEXT_INTEL_BYTES = 512 * 1024
ARCHIVE_POINTER_RE = re.compile(
    r"(?m)^    python3 "
    + re.escape(str(MEASURE_PATH))
    + r" expand ([A-Za-z0-9_-]+)\]$"
)


@dataclass(frozen=True)
class Request:
    protocol_version: int
    action: str
    session: Dict[str, object]
    tool: Optional[Dict[str, object]]
    args: Dict[str, object]


class ProtocolError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class EnvironmentError(ValueError):
    pass


def _json_int(value: str) -> int:
    if len(value) > MAX_JSON_NUMBER_LENGTH:
        raise ValueError("JSON numeric lexeme is too large")
    number = int(value)
    try:
        finite = math.isfinite(float(number))
    except OverflowError:
        finite = False
    if not finite:
        raise ValueError("JSON integer is not finite")
    return number


def _json_float(value: str) -> float:
    if len(value) > MAX_JSON_NUMBER_LENGTH:
        raise ValueError("JSON numeric lexeme is too large")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("JSON number is not finite")
    return number


def _reject_constant(value: str) -> None:
    raise ValueError("invalid JSON constant: " + value)


def _loads(value: str) -> object:
    return json.loads(
        value,
        parse_int=_json_int,
        parse_float=_json_float,
        parse_constant=_reject_constant,
    )


def _text_encoder_normalized(value: str) -> str:
    return value.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")


def _fits(value: str, maximum: int) -> bool:
    return len(_text_encoder_normalized(value).encode("utf-8")) <= maximum


def _is_nonempty_string(value: object, maximum: int = MAX_DESCRIPTOR_STRING_BYTES) -> bool:
    return isinstance(value, str) and bool(value.strip()) and _fits(value, maximum)


def _is_bounded_string(value: object, maximum: int) -> bool:
    return isinstance(value, str) and _fits(value, maximum)


def _is_id(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= MAX_ID_LENGTH
        and ID_RE.fullmatch(value) is not None
    )


def _is_safe_integer(value: object) -> bool:
    if type(value) is int:
        return -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER
    return (
        type(value) is float
        and math.isfinite(value)
        and value.is_integer()
        and -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER
    )


def _is_json_value(value: object, depth: int = 0) -> bool:
    if depth >= 20:
        return False
    if value is None or type(value) is bool:
        return True
    if isinstance(value, str):
        return _fits(value, MAX_TEXT_BYTES)
    if type(value) in {int, float}:
        try:
            return math.isfinite(value)
        except OverflowError:
            return False
    if isinstance(value, list):
        return len(value) <= 10_000 and all(
            _is_json_value(item, depth + 1) for item in value
        )
    if isinstance(value, dict):
        return len(value) <= 1_000 and all(
            isinstance(key, str)
            and _fits(key, 256)
            and _is_json_value(item, depth + 1)
            for key, item in value.items()
        )
    return False


def _is_session(value: object) -> bool:
    if not isinstance(value, dict) or not set(value).issubset(SESSION_KEYS):
        return False
    if not _is_id(value.get("id")) or not _is_nonempty_string(value.get("cwd")):
        return False
    return all(
        key not in value or _is_nonempty_string(value[key])
        for key in ("file", "provider", "model", "reasoningLevel")
    )


def _is_tool(value: object) -> bool:
    return (
        isinstance(value, dict)
        and set(value).issubset(TOOL_KEYS)
        and _is_id(value.get("id"))
        and _is_nonempty_string(value.get("name"))
        and value.get("kind") in {"builtin", "external"}
        and isinstance(value.get("input"), dict)
        and _is_json_value(value["input"])
    )


def _has_required_fields(request: Request) -> bool:
    action = request.action
    args = request.args
    if action == "pre_tool":
        return request.tool is not None
    if action == "post_tool":
        if (
            request.tool is None
            or not _is_bounded_string(args.get("text"), MAX_TEXT_BYTES)
            or type(args.get("isError")) is not bool
            or type(args.get("hasImages")) is not bool
        ):
            return False
        if "fullOutputPath" not in args:
            return True
        full_output = args["fullOutputPath"]
        return (
            request.tool.get("kind") == "builtin"
            and request.tool.get("name") == "bash"
            and _is_nonempty_string(full_output)
        )
    if action == "before_prompt":
        return _is_nonempty_string(args.get("prompt"), MAX_TEXT_BYTES)
    if action in {"rollup", "finalize"}:
        return "file" in request.session
    if action == "expand":
        if not _is_id(args.get("archiveId")):
            return False
        offset_valid = "offset" not in args or (
            _is_safe_integer(args["offset"]) and args["offset"] >= 0
        )
        limit_valid = "limit" not in args or (
            _is_safe_integer(args["limit"])
            and 1 <= args["limit"] <= MAX_EXPANSION_LINES
        )
        return offset_valid and limit_valid
    return True


def parse_request(value: object) -> Request:
    if not isinstance(value, dict):
        raise ProtocolError("invalid_request", "request must be an object")
    if set(value) - REQUEST_KEYS:
        raise ProtocolError("invalid_request", "request contains unknown fields")
    if not _is_safe_integer(value.get("protocolVersion")):
        raise ProtocolError("invalid_request", "protocol version must be an integer")
    if value["protocolVersion"] != PROTOCOL_VERSION:
        raise ProtocolError("unsupported_protocol", "unsupported protocol version")
    action = value.get("action")
    if not isinstance(action, str):
        raise ProtocolError("invalid_request", "action must be a string")
    if action not in ACTIONS:
        raise ProtocolError("unknown_action", "unknown action")
    if not _is_session(value.get("session")):
        raise ProtocolError("invalid_request", "invalid session descriptor")
    tool = value.get("tool")
    if "tool" in value and not _is_tool(tool):
        raise ProtocolError("invalid_request", "invalid tool descriptor")
    args = value.get("args", {})
    if not isinstance(args, dict) or not _is_json_value(args):
        raise ProtocolError("invalid_request", "invalid action arguments")
    if tool is not None and action not in {"pre_tool", "post_tool"}:
        raise ProtocolError("invalid_request", "tool is not valid for this action")

    request = Request(
        protocol_version=PROTOCOL_VERSION,
        action=action,
        session=value["session"],
        tool=tool,
        args=args,
    )
    if not _has_required_fields(request):
        raise ProtocolError("invalid_request", "missing or invalid action fields")
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if not _fits(encoded, MAX_REQUEST_BYTES):
        raise ProtocolError("request_too_large", "request exceeds the size limit")
    return request


def _read_request(stream: TextIO) -> object:
    source = getattr(stream, "buffer", stream)
    data = source.read(MAX_REQUEST_BYTES + 1)
    if isinstance(data, str):
        data = data.encode("utf-8")
    if len(data) > MAX_REQUEST_BYTES:
        raise ProtocolError("request_too_large", "request exceeds the size limit")
    if not data:
        raise ProtocolError("invalid_request", "request is empty")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ProtocolError("invalid_request", "request is not UTF-8") from error
    try:
        return _loads(text)
    except (json.JSONDecodeError, RecursionError, ValueError) as error:
        raise ProtocolError("invalid_json", "request is not valid JSON") from error


def _canonical_home() -> Path:
    raw = os.environ.get("TOKEN_OPTIMIZER_PI_HOME", "")
    if not raw.strip():
        raise EnvironmentError("TOKEN_OPTIMIZER_PI_HOME is required")
    candidate = Path(raw)
    try:
        if not candidate.is_absolute() or candidate.is_symlink() or not candidate.is_dir():
            raise EnvironmentError("TOKEN_OPTIMIZER_PI_HOME must be a real directory")
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise EnvironmentError("TOKEN_OPTIMIZER_PI_HOME is not usable") from error
    if resolved != candidate:
        raise EnvironmentError("TOKEN_OPTIMIZER_PI_HOME must resolve exactly")
    return resolved


def _configure_environment(request: Request) -> Tuple[Path, Path]:
    pi_home = _canonical_home()
    optimizer_root = pi_home / "token-optimizer"
    data_root = optimizer_root / "data"
    if optimizer_root.is_symlink() or (
        optimizer_root.exists()
        and (not optimizer_root.is_dir() or optimizer_root.resolve() != optimizer_root)
    ):
        raise EnvironmentError("Pi optimizer root is unsafe")
    if data_root.is_symlink() or (
        data_root.exists()
        and (not data_root.is_dir() or data_root.resolve() != data_root)
    ):
        raise EnvironmentError("TOKEN_OPTIMIZER_SNAPSHOT_DIR is unsafe")

    os.environ["TOKEN_OPTIMIZER_RUNTIME"] = "pi"
    os.environ["TOKEN_OPTIMIZER_PI_HOME"] = str(pi_home)
    os.environ["TOKEN_OPTIMIZER_SNAPSHOT_DIR"] = str(data_root)
    os.environ["PI_SESSION_ID"] = str(request.session["id"])
    environment_fields = {
        "PI_SESSION_FILE": "file",
        "PI_PROVIDER": "provider",
        "PI_MODEL": "model",
        "PI_REASONING_LEVEL": "reasoningLevel",
    }
    for environment_key, session_key in environment_fields.items():
        value = request.session.get(session_key)
        if isinstance(value, str):
            normalized = _text_encoder_normalized(value)
            if "\x00" not in normalized:
                os.environ[environment_key] = normalized
                continue
        os.environ.pop(environment_key, None)
    return pi_home, data_root


def _is_iso_date(value: object) -> bool:
    if not isinstance(value, str) or len(value) > 128 or ISO_DATE_RE.fullmatch(value) is None:
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return True


def _config_result(pi_home: Path) -> Dict[str, object]:
    root = pi_home / "token-optimizer"
    path = root / "config.json"
    base: Dict[str, object] = {
        "state": "missing",
        "enabled": True,
        "consentGranted": False,
        "noticeVersion": 1,
    }
    try:
        if root.is_symlink() or (
            root.exists() and (not root.is_dir() or root.resolve() != root)
        ):
            return dict(base, state="malformed")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(str(path), flags)
    except FileNotFoundError:
        return base
    except OSError:
        return dict(base, state="malformed")

    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_CONFIG_BYTES:
            return dict(base, state="malformed")
        with os.fdopen(descriptor, "rb") as handle:
            descriptor = -1
            raw = handle.read(MAX_CONFIG_BYTES + 1)
        if len(raw) > MAX_CONFIG_BYTES:
            return dict(base, state="malformed")
        value = _loads(raw.decode("utf-8", errors="strict"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
        return dict(base, state="malformed")
    finally:
        if descriptor >= 0:
            os.close(descriptor)

    if not isinstance(value, dict):
        return dict(base, state="malformed")
    enabled = value.get("enabled", True)
    schema = value.get("schemaVersion", 1)
    consent = value.get("consent", {})
    if (
        type(enabled) is not bool
        or not _is_safe_integer(schema)
        or not isinstance(consent, dict)
    ):
        return dict(base, state="malformed")
    if schema > 1:
        return dict(base, state="future")
    granted = consent.get("granted", False)
    notice = consent.get("noticeVersion")
    if (
        ("granted" in consent and type(granted) is not bool)
        or ("noticeVersion" in consent and not _is_safe_integer(notice))
    ):
        return dict(base, state="malformed")
    consent_granted = granted is True and notice == 1
    if consent_granted and "grantedAt" in consent and not _is_iso_date(consent["grantedAt"]):
        return dict(base, state="malformed")
    return {
        "state": "valid",
        "enabled": enabled,
        "consentGranted": consent_granted,
        "noticeVersion": 1,
    }


def _contains(path: Path, snippets: Tuple[str, ...]) -> bool:
    try:
        if path.is_symlink() or not path.is_file():
            return False
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    return all(snippet in text for snippet in snippets)


def _runtime_checks(pi_home: Path, data_root: Path) -> Dict[str, bool]:
    manifest_ok = False
    try:
        manifest = _loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        upstream = manifest.get("upstream") if isinstance(manifest, dict) else None
        protocol = manifest.get("protocol") if isinstance(manifest, dict) else None
        manifest_ok = (
            isinstance(upstream, dict)
            and upstream.get("version") == UPSTREAM_VERSION
            and upstream.get("commit") == UPSTREAM_COMMIT
            and isinstance(protocol, dict)
            and protocol.get("version") == PROTOCOL_VERSION
        )
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        pass

    return {
        "python39": sys.version_info >= (3, 9),
        "piHome": pi_home.is_dir() and not pi_home.is_symlink(),
        "dataRoot": not data_root.exists() or (data_root.is_dir() and not data_root.is_symlink()),
        "manifest": manifest_ok,
        "vendorRuntime": _contains(
            RUNTIME_PATH,
            ("_RUNTIME_PI = \"pi\"", "def pi_home()", "return \"Pi\""),
        ) and _contains(
            MEASURE_PATH,
            ("import pi_session", "def _use_pi_session_adapter", "\"pi\"")
        ),
        "vendorPatch": PATCH_PATH.is_file() and not PATCH_PATH.is_symlink(),
        "piSessionParser": _contains(
            PARSER_PATH,
            (
                "def active_entries(",
                "def parse_session_jsonl(",
                "def parse_jsonl_for_quality(",
                "def iter_tool_outputs(",
            ),
        ),
    }


def _status_data(request: Request, pi_home: Path, data_root: Path) -> Dict[str, object]:
    config = _config_result(pi_home)
    checks = _runtime_checks(pi_home, data_root)
    active = (
        config["state"] == "valid"
        and config["enabled"] is True
        and config["consentGranted"] is True
    )
    paths: Dict[str, object] = {
        "piHome": str(pi_home),
        "dataRoot": str(data_root),
    }
    if "file" in request.session:
        paths["sessionFile"] = request.session["file"]
    return {
        "active": active,
        "runtime": "pi",
        "protocolVersion": PROTOCOL_VERSION,
        "upstreamVersion": UPSTREAM_VERSION,
        "upstreamCommit": UPSTREAM_COMMIT,
        "pythonVersion": ".".join(str(part) for part in sys.version_info[:3]),
        "paths": paths,
        "config": config,
        "checks": checks,
        "healthy": all(checks.values()) and config["state"] in {"missing", "valid"},
    }


def _ok(data: Optional[Dict[str, object]] = None) -> Dict[str, object]:
    response: Dict[str, object] = {"protocolVersion": PROTOCOL_VERSION, "ok": True}
    if data is not None:
        response["data"] = data
    return response


def _error(code: str) -> Dict[str, object]:
    return {"protocolVersion": PROTOCOL_VERSION, "ok": False, "errorCode": code}


def _allow() -> Dict[str, object]:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "ok": True,
        "decision": "allow",
    }


def _diagnose(message: str) -> None:
    text = " ".join(str(message).split())[:MAX_DIAGNOSTIC_CHARS]
    if text:
        print("pi bridge engine: " + text, file=sys.stderr)


def _engine_module(name: str) -> object:
    scripts = str(SCRIPTS_PATH)
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    return __import__(name)


def _load_engine(name: str) -> object:
    output = io.StringIO()
    errors = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
        module = _engine_module(name)
    if errors.getvalue():
        _diagnose("engine import diagnostic")
    if output.getvalue():
        raise ValueError("engine import wrote to stdout")
    return module


def _capture_hook(
    module: object,
    payload: Dict[str, object],
    arguments: Tuple[str, ...] = (),
    entrypoint: str = "main",
) -> str:
    hook_io = _load_engine("hook_io")
    original_reader = hook_io.read_stdin_hook_input
    module_reader = getattr(module, "read_stdin_hook_input", None)
    original_argv = sys.argv
    output = io.StringIO()
    errors = io.StringIO()
    reader = lambda *args, **kwargs: payload
    hook_io.read_stdin_hook_input = reader
    if module_reader is not None:
        module.read_stdin_hook_input = reader
    sys.argv = [original_argv[0], *arguments]
    try:
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            getattr(module, entrypoint)()
    finally:
        sys.argv = original_argv
        hook_io.read_stdin_hook_input = original_reader
        if module_reader is not None:
            module.read_stdin_hook_input = module_reader
    if errors.getvalue().strip():
        _diagnose("engine diagnostic")
    return output.getvalue()


def _known_hook_output(
    raw: str,
    event_name: str = "PreToolUse",
) -> Optional[Dict[str, object]]:
    if not raw.strip():
        return None
    try:
        decoder = json.JSONDecoder()
        value, end = decoder.raw_decode(raw)
    except (json.JSONDecodeError, RecursionError, ValueError):
        raise ValueError("malformed engine output")
    if raw[end:].strip() or not isinstance(value, dict) or set(value) != {"hookSpecificOutput"}:
        raise ValueError("malformed engine output")
    output = value["hookSpecificOutput"]
    if not isinstance(output, dict) or output.get("hookEventName") != event_name:
        raise ValueError("malformed engine output")
    return output


def _tool_payload(request: Request) -> Tuple[str, Dict[str, object]]:
    assert request.tool is not None
    name = str(request.tool["name"])
    tool_input = dict(request.tool["input"])
    if request.tool["kind"] == "builtin":
        name = ENGINE_TOOL_NAMES.get(name.lower(), "")
        if name in {"Read", "Edit", "Write"}:
            path = tool_input.pop("path", None)
            if path is not None:
                tool_input["file_path"] = path
    return name, {
        "session_id": request.session["id"],
        "agent_id": request.session["id"],
        "cwd": request.session["cwd"],
        "tool_use_id": request.tool["id"],
        "tool_name": name,
        "tool_input": tool_input,
    }


def _read_response(raw: str) -> Dict[str, object]:
    output = _known_hook_output(raw)
    if output is None:
        return _allow()
    allowed = {
        "hookEventName",
        "permissionDecision",
        "permissionDecisionReason",
        "additionalContext",
    }
    if not set(output).issubset(allowed):
        raise ValueError("unexpected Read hook envelope")
    decision = output.get("permissionDecision")
    if decision not in {None, "allow", "deny"}:
        raise ValueError("invalid Read decision")
    reason = output.get("permissionDecisionReason")
    context = output.get("additionalContext")
    if reason is not None and not isinstance(reason, str):
        raise ValueError("invalid Read reason")
    if context is not None and not isinstance(context, str):
        raise ValueError("invalid Read context")
    response = _allow()
    if decision == "deny":
        response["decision"] = "block"
    data = {}
    if reason:
        data["reason"] = reason
    if context:
        data["additionalContext"] = context
    if data:
        response["data"] = data
    encoded = json.dumps(response, ensure_ascii=True, separators=(",", ":"))
    if not _fits(encoded, MAX_RESPONSE_BYTES):
        raise ValueError("Read hook output exceeds response limit")
    return response


def _external_pre_tool(request: Request, payload: Dict[str, object]) -> Dict[str, object]:
    assert request.tool is not None
    try:
        guard = _load_engine("refetch_guard")
        output = io.StringIO()
        errors = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            fingerprint = guard.tool_fingerprint(
                request.tool["name"],
                payload["tool_input"],
            )
            archived_id, saved_tokens = guard._lookup_archived(
                request.session["id"],
                request.tool["name"],
                fingerprint,
            )
            if _is_id(archived_id):
                guard._log_refetch_block(
                    request.session["id"],
                    request.tool["name"],
                    archived_id,
                    saved_tokens,
                )
        if output.getvalue():
            raise ValueError("refetch guard wrote to stdout")
        if errors.getvalue():
            _diagnose("engine diagnostic")
        if not _is_id(archived_id):
            return _allow()
        reason = (
            "Token Optimizer: this exact " + str(request.tool["name"])
            + " call already ran and its full result is archived on disk (id "
            + archived_id
            + ") — re-fetching would re-inflate context with data you already have. "
            "Do NOT call it again. Read the saved result by running this in Bash:\n    "
            + guard.expand_command(archived_id)
        )
        response = _allow()
        response["decision"] = "block"
        response["data"] = {"reason": reason}
        return response
    except (Exception, SystemExit) as error:
        _diagnose("engine failure (" + type(error).__name__ + ")")
        return _allow()


def _pre_tool(request: Request) -> Dict[str, object]:
    assert request.tool is not None
    name, payload = _tool_payload(request)
    if request.tool["kind"] == "external":
        return _external_pre_tool(request, payload)
    if request.tool["kind"] == "builtin" and name == "Read":
        try:
            read_cache = _load_engine("read_cache")
            original_escape = read_cache._check_escape_hatch

            def persisted_escape(entry, *args, **kwargs):
                entry["consecutive_denials"] = int(
                    entry.get("repeat_replacement_count", 0) or 0
                )
                return original_escape(entry, *args, **kwargs)

            read_cache._check_escape_hatch = persisted_escape
            try:
                raw = _capture_hook(read_cache, payload, ("--quiet",))
            finally:
                read_cache._check_escape_hatch = original_escape
            return _read_response(raw)
        except (Exception, SystemExit) as error:
            _diagnose("engine failure (" + type(error).__name__ + ")")
            return _allow()
    if request.tool["kind"] != "builtin" or name != "Bash":
        return _allow()
    command = payload["tool_input"].get("command")
    if not isinstance(command, str) or not command:
        return _allow()
    try:
        output = _known_hook_output(
            _capture_hook(_load_engine("bash_hook"), payload)
        )
        if output is None:
            return _allow()
        if set(output) != {
            "hookEventName",
            "permissionDecision",
            "updatedInput",
        } or output.get("permissionDecision") != "allow":
            raise ValueError("unexpected Bash hook envelope")
        updated = output.get("updatedInput")
        if (
            not isinstance(updated, dict)
            or set(updated) != {"command"}
            or not isinstance(updated.get("command"), str)
            or not updated["command"]
            or updated["command"] == command
        ):
            raise ValueError("invalid Bash rewrite")
        response = _allow()
        response["updatedInput"] = updated
        encoded = json.dumps(response, ensure_ascii=True, separators=(",", ":"))
        if not _fits(encoded, MAX_RESPONSE_BYTES):
            return _allow()
        return response
    except (Exception, SystemExit) as error:
        _diagnose("engine failure (" + type(error).__name__ + ")")
        return _allow()


def _read_owned_regular(path: Path, maximum: int) -> Optional[bytes]:
    descriptor = -1
    try:
        if path.is_symlink():
            return None
        flags = (
            os.O_RDONLY
            | getattr(os, "O_NOFOLLOW", 0)
            | getattr(os, "O_NONBLOCK", 0)
        )
        descriptor = os.open(str(path), flags)
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_size > maximum
        ):
            return None
        chunks = []
        remaining = maximum + 1
        while remaining:
            chunk = os.read(descriptor, min(remaining, 64 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        return data if len(data) <= maximum else None
    except (OSError, ValueError):
        return None
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _bash_output(request: Request) -> str:
    visible = str(request.args["text"])
    raw_path = request.args.get("fullOutputPath")
    if not isinstance(raw_path, str):
        return visible
    data = _read_owned_regular(Path(raw_path), MAX_TEXT_BYTES)
    if data is None:
        return visible
    try:
        decoded = data.decode("utf-8", errors="strict")
        return visible if "\x00" in decoded else decoded
    except UnicodeDecodeError:
        return visible


def _archive_id_from_pointer(replacement: str) -> Optional[str]:
    matches = ARCHIVE_POINTER_RE.findall(replacement)
    if len(matches) != 1 or not _is_id(matches[0]):
        return None
    return matches[0]


def _external_archive_pointer(
    replacement: str,
    archive_id: str,
    tool_name: str,
) -> bool:
    footer = (
        f"Do NOT call {tool_name} again to get this data — read the saved copy by "
        "running this in Bash:\n"
        f"    python3 {MEASURE_PATH} expand {archive_id}]"
    )
    return (
        "[Full result archived (" in replacement
        and replacement.endswith(footer)
        and _archive_id_from_pointer(replacement) == archive_id
    )


def _archive_destination_safe(data_root: Path, session_id: str) -> bool:
    paths = (
        data_root,
        data_root / "tool-archive",
        data_root / "tool-archive" / session_id,
    )
    for path in paths:
        try:
            if path.is_symlink() or (path.exists() and not path.is_dir()):
                return False
        except OSError:
            return False
    return True


def _safe_archive_directory(data_root: Path, session_id: str) -> Optional[Path]:
    archive_root = data_root / "tool-archive"
    session_dir = archive_root / session_id
    for path in (data_root, archive_root, session_dir):
        try:
            info = path.lstat()
            if path.is_symlink() or not stat.S_ISDIR(info.st_mode):
                return None
        except OSError:
            return None
    return session_dir


def _verified_archive(
    data_root: Path,
    session_id: str,
    archive_id: str,
    tool_name: str,
    tool_kind: Optional[str] = None,
) -> bool:
    session_dir = _safe_archive_directory(data_root, session_id)
    if session_dir is None or not _is_id(archive_id):
        return False
    entry_raw = _read_owned_regular(
        session_dir / (archive_id + ".json"),
        MAX_ARCHIVE_ENTRY_BYTES,
    )
    manifest_raw = _read_owned_regular(
        session_dir / "manifest.jsonl",
        MAX_ARCHIVE_MANIFEST_BYTES,
    )
    if entry_raw is None or manifest_raw is None:
        return False
    try:
        entry = _loads(entry_raw.decode("utf-8", errors="strict"))
        if (
            not isinstance(entry, dict)
            or entry.get("tool_use_id") != archive_id
            or entry.get("tool_name") != tool_name
            or (tool_kind is not None and entry.get("tool_kind") != tool_kind)
            or not isinstance(entry.get("response"), str)
        ):
            return False
        matching = []
        for line in manifest_raw.decode("utf-8", errors="strict").splitlines():
            record = _loads(line)
            if isinstance(record, dict) and record.get("tool_use_id") == archive_id:
                matching.append(record)
        return bool(matching) and (
            matching[-1].get("tool_name") == tool_name
            and (
                tool_kind is None
                or matching[-1].get("tool_kind") == tool_kind
            )
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
        return False
    return False


def _bounded_text(value: str, maximum: int) -> str:
    encoded = value.encode("utf-8", errors="replace")[:maximum]
    return encoded.decode("utf-8", errors="ignore")


def _best_effort_post_metadata(
    request: Request,
    payload: Dict[str, object],
    text: str,
) -> None:
    context_payload = dict(payload)
    context_payload["tool_response"] = _bounded_text(text, MAX_CONTEXT_INTEL_BYTES)
    try:
        raw = _capture_hook(
            _load_engine("context_intel"),
            context_payload,
            entrypoint="handle_post_tool_use",
        )
        if raw.strip():
            raise ValueError("context intel wrote to stdout")
    except (Exception, SystemExit) as error:
        _diagnose("metadata failure (" + type(error).__name__ + ")")

    quality_payload: Dict[str, object] = {"session_id": request.session["id"]}
    session_file = request.session.get("file")
    if isinstance(session_file, str):
        quality_payload["transcript_path"] = session_file
    try:
        quality_gate = _load_engine("quality_cache_gate")
        original_self_heal = quality_gate._quality_cache_self_heal
        quality_gate._quality_cache_self_heal = lambda _measure: None
        try:
            raw = _capture_hook(
                quality_gate,
                quality_payload,
                ("--quiet", "--throttle-only"),
            )
        finally:
            quality_gate._quality_cache_self_heal = original_self_heal
        if raw.strip():
            raise ValueError("quality gate wrote to stdout")
    except (Exception, SystemExit) as error:
        _diagnose("metadata failure (" + type(error).__name__ + ")")


def _invalidate_read_cache(payload: Dict[str, object]) -> None:
    try:
        output = io.StringIO()
        errors = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            _load_engine("read_cache").handle_invalidate(payload, quiet=True)
        if output.getvalue().strip():
            raise ValueError("read cache invalidation wrote to stdout")
        if errors.getvalue().strip():
            _diagnose("engine diagnostic")
    except (Exception, SystemExit) as error:
        _diagnose("engine failure (" + type(error).__name__ + ")")


def _external_post_tool(
    request: Request,
    payload: Dict[str, object],
    data_root: Path,
    text: str,
) -> Dict[str, object]:
    assert request.tool is not None
    archive_result = None
    try:
        module = _load_engine("archive_result")
        output = io.StringIO()
        errors = io.StringIO()
        hook_payload = dict(payload)
        hook_payload["tool_kind"] = request.tool["kind"]
        hook_payload["tool_response"] = text
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            archive_result = module.archive_result(
                quiet=True,
                hook_input=hook_payload,
            )
        if output.getvalue().strip():
            raise ValueError("archive result wrote to stdout")
        if errors.getvalue().strip():
            _diagnose("engine diagnostic")
    except (Exception, SystemExit) as error:
        _diagnose("engine failure (" + type(error).__name__ + ")")

    _best_effort_post_metadata(request, payload, text)
    if not isinstance(archive_result, dict) or set(archive_result) != {
        "archive_id",
        "replacement_text",
        "metadata",
    }:
        return _allow()
    archive_id = archive_result.get("archive_id")
    replacement = archive_result.get("replacement_text")
    metadata = archive_result.get("metadata")
    if (
        not _is_id(archive_id)
        or not isinstance(replacement, str)
        or not replacement
        or not isinstance(metadata, dict)
        or archive_id != request.tool["id"]
        or metadata.get("tool_use_id") != archive_id
        or metadata.get("tool_name") != request.tool["name"]
        or metadata.get("tool_kind") != "external"
        or not _external_archive_pointer(
            replacement,
            archive_id,
            str(request.tool["name"]),
        )
        or not _verified_archive(
            data_root,
            str(request.session["id"]),
            archive_id,
            str(request.tool["name"]),
            "external",
        )
    ):
        return _allow()
    response = _allow()
    response["replacementText"] = replacement
    response["archiveId"] = archive_id
    if not _fits(
        json.dumps(response, ensure_ascii=True, separators=(",", ":")),
        MAX_RESPONSE_BYTES,
    ):
        return _allow()
    return response


def _bash_post_tool(
    request: Request,
    payload: Dict[str, object],
    data_root: Path,
    text: str,
) -> Dict[str, object]:
    try:
        hook_payload = dict(payload)
        hook_payload["tool_response"] = {
            "stdout": text,
            "stderr": "",
            "interrupted": False,
            "isImage": False,
        }
        output = _known_hook_output(
            _capture_hook(_load_engine("bash_compress_hook"), hook_payload),
            "PostToolUse",
        )
        if output is None or set(output) != {"hookEventName", "updatedToolOutput"}:
            return _allow()
        updated = output.get("updatedToolOutput")
        if not isinstance(updated, dict) or set(updated) != {
            "stdout",
            "stderr",
            "interrupted",
            "isImage",
        }:
            return _allow()
        replacement = updated.get("stdout")
        if (
            not isinstance(replacement, str)
            or not replacement
            or replacement == text
            or updated.get("stderr") != ""
            or updated.get("interrupted") is not False
            or updated.get("isImage") is not False
        ):
            return _allow()
        archive_id = _archive_id_from_pointer(replacement)
        if archive_id is None or not _verified_archive(
            data_root,
            str(request.session["id"]),
            archive_id,
            "Bash",
        ):
            return _allow()
        response = _allow()
        response["replacementText"] = replacement
        response["archiveId"] = archive_id
        if not _fits(
            json.dumps(response, ensure_ascii=True, separators=(",", ":")),
            MAX_RESPONSE_BYTES,
        ):
            return _allow()
        return response
    except (Exception, SystemExit) as error:
        _diagnose("engine failure (" + type(error).__name__ + ")")
        return _allow()
    finally:
        _best_effort_post_metadata(request, payload, text)


def _post_tool(request: Request, data_root: Path) -> Dict[str, object]:
    assert request.tool is not None
    if request.args["isError"] or request.args["hasImages"]:
        return _allow()
    visible = str(request.args["text"])
    name, payload = _tool_payload(request)
    if request.tool["kind"] == "builtin" and name in {"Edit", "Write"}:
        _invalidate_read_cache(payload)
        _best_effort_post_metadata(request, payload, visible)
        return _allow()
    if "\x00" in visible:
        return _allow()
    if not _archive_destination_safe(data_root, str(request.session["id"])):
        return _allow()
    if request.tool["kind"] == "external":
        return _external_post_tool(request, payload, data_root, visible)
    if request.tool["kind"] == "builtin" and name == "Bash":
        return _bash_post_tool(request, payload, data_root, _bash_output(request))
    return _allow()


def dispatch(request: Request) -> Dict[str, object]:
    pi_home, data_root = _configure_environment(request)
    if request.action in {"status", "doctor"}:
        return _ok(_status_data(request, pi_home, data_root))

    config = _config_result(pi_home)
    if config["state"] != "valid":
        reason = (
            "consent_required"
            if config["state"] == "missing"
            else "config_invalid"
        )
    elif config["enabled"] is not True:
        reason = "disabled"
    elif config["consentGranted"] is not True:
        reason = "consent_required"
    elif request.action == "pre_tool":
        return _pre_tool(request)
    elif request.action == "post_tool":
        return _post_tool(request, data_root)
    else:
        return _error("not_implemented")
    return _ok({
        "active": False,
        "reason": reason,
        "configState": config["state"],
    })


def _emit(response: Dict[str, object], stream: TextIO) -> None:
    payload = json.dumps(
        response,
        ensure_ascii=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    if not _fits(payload, MAX_RESPONSE_BYTES):
        payload = json.dumps(_error("response_too_large"), separators=(",", ":"))
    stream.write(payload + "\n")
    stream.flush()


def main(
    input_stream: Optional[TextIO] = None,
    output_stream: Optional[TextIO] = None,
    error_stream: Optional[TextIO] = None,
) -> int:
    input_stream = input_stream if input_stream is not None else sys.stdin
    output_stream = output_stream if output_stream is not None else sys.stdout
    error_stream = error_stream if error_stream is not None else sys.stderr
    try:
        request = parse_request(_read_request(input_stream))
        with contextlib.redirect_stderr(error_stream):
            response = dispatch(request)
    except ProtocolError as error:
        print(str(error), file=error_stream)
        response = _error(error.code)
    except EnvironmentError as error:
        print(str(error), file=error_stream)
        response = _error("invalid_environment")
    except Exception as error:
        print("pi bridge internal error: " + str(error), file=error_stream)
        response = _error("internal_error")
    _emit(response, output_stream)
    return 0


if __name__ == "__main__":
    sys.exit(main())
