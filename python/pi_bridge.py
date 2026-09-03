#!/usr/bin/env python3
"""Versioned, one-shot protocol boundary for the Pi Token Optimizer."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
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
