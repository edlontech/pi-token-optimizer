import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


sys.dont_write_bytecode = True
from python import pi_bridge


ROOT = Path(__file__).parents[2]
BRIDGE = ROOT / "python" / "pi_bridge.py"
PINNED_COMMIT = "eda65d61b4750b530a6f9956193d4e4632aca0cb"
ACTIVITY_ACTIONS = (
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
)


class PiBridgeProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name).resolve()
        self.pi_home = self.root / "pi-home"
        self.data_root = self.pi_home / "token-optimizer" / "data"
        self.data_root.mkdir(parents=True)
        self.session_file = self.root / "session.jsonl"
        self.session_file.write_text("", encoding="utf-8")
        self.session = {
            "id": "session-1",
            "cwd": str(self.root),
            "file": str(self.session_file),
        }
        self.environment = {
            "HOME": str(self.root),
            "PATH": os.environ.get("PATH", ""),
            "PYTHONDONTWRITEBYTECODE": "1",
            "TOKEN_OPTIMIZER_PI_HOME": str(self.pi_home),
            "TOKEN_OPTIMIZER_RUNTIME": "claude",
            "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(self.root / "foreign-snapshot"),
            "PI_SESSION_ID": "foreign-session",
            "PI_SESSION_FILE": str(self.root / "foreign-session.jsonl"),
            "CLAUDE_CONFIG_DIR": str(self.root / ".claude"),
            "CODEX_HOME": str(self.root / ".codex"),
        }

    def request(self, action="status"):
        return {"protocolVersion": 1, "action": action, "session": dict(self.session)}

    def invoke_raw(self, payload, environment=None):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        completed = subprocess.run(
            [sys.executable, str(BRIDGE)],
            input=payload,
            capture_output=True,
            env=self.environment if environment is None else environment,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
        stdout = completed.stdout.decode("utf-8", "strict")
        self.assertEqual(len(stdout.splitlines()), 1, stdout)
        response, end = json.JSONDecoder().raw_decode(stdout)
        self.assertEqual(stdout[end:], "\n")
        self.assertIsInstance(response, dict)
        self.assertNotIn("Traceback", stdout)
        self.assertNotIn("Traceback", completed.stderr.decode("utf-8", "replace"))
        return response, completed.stderr.decode("utf-8", "replace")

    def invoke(self, request, environment=None):
        return self.invoke_raw(
            json.dumps(request, ensure_ascii=False, separators=(",", ":")),
            environment,
        )

    def write_config(self, value):
        path = self.pi_home / "token-optimizer" / "config.json"
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def grant_consent(self, enabled=True):
        self.write_config({
            "schemaVersion": 1,
            "enabled": enabled,
            "consent": {
                "granted": True,
                "noticeVersion": 1,
                "grantedAt": "2026-09-03T12:00:00.000Z",
            },
        })

    def action_request(self, action):
        request = self.request(action)
        tool = {
            "id": "tool-1",
            "name": "bash",
            "kind": "builtin",
            "input": {"command": "printf ok"},
        }
        if action == "pre_tool":
            request["tool"] = tool
        elif action == "post_tool":
            request["tool"] = tool
            request["args"] = {"text": "ok", "isError": False, "hasImages": False}
        elif action == "before_prompt":
            request["args"] = {"prompt": "continue"}
        elif action == "expand":
            request["args"] = {"archiveId": "archive_1", "offset": 0, "limit": 100}
        return request

    def test_status_reports_the_pinned_isolated_runtime_without_consent(self):
        response, _stderr = self.invoke(self.request())

        self.assertTrue(response["ok"])
        self.assertEqual(response["protocolVersion"], 1)
        self.assertFalse(response["data"]["active"])
        self.assertEqual(response["data"]["runtime"], "pi")
        self.assertEqual(response["data"]["protocolVersion"], 1)
        self.assertEqual(response["data"]["upstreamVersion"], "5.13.4")
        self.assertEqual(response["data"]["upstreamCommit"], PINNED_COMMIT)
        self.assertRegex(response["data"]["pythonVersion"], r"^\d+\.\d+\.\d+$")
        self.assertEqual(response["data"]["paths"]["piHome"], str(self.pi_home))
        self.assertEqual(response["data"]["paths"]["dataRoot"], str(self.data_root))
        self.assertEqual(response["data"]["paths"]["sessionFile"], str(self.session_file))
        self.assertEqual(response["data"]["config"]["state"], "missing")
        self.assertTrue(response["data"]["checks"]["python39"])
        self.assertTrue(response["data"]["checks"]["manifest"])
        self.assertTrue(response["data"]["checks"]["vendorRuntime"])
        self.assertTrue(response["data"]["checks"]["vendorPatch"])
        self.assertTrue(response["data"]["checks"]["piSessionParser"])
        self.assertTrue(response["data"]["healthy"])
        self.assertFalse((self.pi_home / "token-optimizer" / "config.json").exists())

    def test_doctor_works_without_consent_and_reports_missing_artifacts(self):
        response, _stderr = self.invoke(self.request("doctor"))
        self.assertTrue(response["ok"])
        self.assertTrue(response["data"]["healthy"])

        with mock.patch.object(pi_bridge, "PATCH_PATH", self.root / "missing.patch"):
            with mock.patch.object(pi_bridge, "PARSER_PATH", self.root / "missing.py"):
                with mock.patch.dict(os.environ, self.environment, clear=True):
                    output = io.StringIO()
                    errors = io.StringIO()
                    result = pi_bridge.main(
                        io.StringIO(json.dumps(self.request("doctor"))),
                        output,
                        errors,
                    )

        self.assertEqual(result, 0)
        direct = json.loads(output.getvalue())
        self.assertFalse(direct["data"]["checks"]["vendorPatch"])
        self.assertFalse(direct["data"]["checks"]["piSessionParser"])
        self.assertFalse(direct["data"]["healthy"])
        self.assertEqual(errors.getvalue(), "")

    def test_status_and_doctor_report_only_corrupt_config_as_unhealthy(self):
        cases = (
            ("{", "malformed", False),
            (json.dumps({"schemaVersion": 2}), "future", False),
            (json.dumps({"consent": {"granted": False}}), "valid", True),
            (json.dumps({"enabled": False}), "valid", True),
        )
        config_path = self.pi_home / "token-optimizer" / "config.json"
        for action in ("status", "doctor"):
            for raw, state, healthy in cases:
                with self.subTest(action=action, state=state, healthy=healthy):
                    config_path.write_text(raw, encoding="utf-8")
                    response, _stderr = self.invoke(self.request(action))
                    self.assertEqual(response["data"]["config"]["state"], state)
                    self.assertEqual(response["data"]["healthy"], healthy)
                    self.assertFalse(response["data"]["active"])

    def test_main_configures_request_owned_environment_before_dispatch(self):
        self.grant_consent()
        request = self.request("before_prompt")
        request["session"].update({
            "provider": "provider-1",
            "model": "model-1",
            "reasoningLevel": "high",
        })
        request["args"] = {"prompt": "continue"}
        output = io.StringIO()
        errors = io.StringIO()

        with mock.patch.dict(os.environ, self.environment, clear=True):
            result = pi_bridge.main(io.StringIO(json.dumps(request)), output, errors)
            configured = {
                key: os.environ.get(key)
                for key in (
                    "TOKEN_OPTIMIZER_RUNTIME",
                    "TOKEN_OPTIMIZER_PI_HOME",
                    "TOKEN_OPTIMIZER_SNAPSHOT_DIR",
                    "PI_SESSION_ID",
                    "PI_SESSION_FILE",
                    "PI_PROVIDER",
                    "PI_MODEL",
                    "PI_REASONING_LEVEL",
                )
            }

        self.assertEqual(result, 0)
        self.assertEqual(errors.getvalue(), "")
        self.assertEqual(json.loads(output.getvalue()), {
            "protocolVersion": 1,
            "ok": True,
        })
        self.assertEqual(configured, {
            "TOKEN_OPTIMIZER_RUNTIME": "pi",
            "TOKEN_OPTIMIZER_PI_HOME": str(self.pi_home),
            "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(self.data_root),
            "PI_SESSION_ID": "session-1",
            "PI_SESSION_FILE": str(self.session_file),
            "PI_PROVIDER": "provider-1",
            "PI_MODEL": "model-1",
            "PI_REASONING_LEVEL": "high",
        })

    def test_safe_integer_json_numbers_match_javascript_semantics(self):
        for protocol_version in ("1.0", "1e0"):
            with self.subTest(protocol_version=protocol_version):
                payload = json.dumps(self.request(), separators=(",", ":")).replace(
                    '"protocolVersion":1',
                    '"protocolVersion":' + protocol_version,
                )
                response, _stderr = self.invoke_raw(payload)
                self.assertTrue(response["ok"])

        payload = json.dumps(self.request(), separators=(",", ":")).replace(
            '"protocolVersion":1',
            '"protocolVersion":2.0',
        )
        response, _stderr = self.invoke_raw(payload)
        self.assertEqual(response["errorCode"], "unsupported_protocol")

        config_path = self.pi_home / "token-optimizer" / "config.json"
        for schema, notice in (("1.0", "1e0"), ("1e0", "1.0")):
            with self.subTest(schema=schema, notice=notice):
                config_path.write_text(
                    '{"schemaVersion":' + schema
                    + ',"enabled":true,"consent":{"granted":true,"noticeVersion":'
                    + notice
                    + ',"grantedAt":"2026-09-03T12:00:00.000Z"}}',
                    encoding="utf-8",
                )
                response, _stderr = self.invoke(self.request())
                self.assertEqual(response["data"]["config"]["state"], "valid")
                self.assertTrue(response["data"]["active"])

        config_path.write_text('{"schemaVersion":2.0}', encoding="utf-8")
        response, _stderr = self.invoke(self.request())
        self.assertEqual(response["data"]["config"]["state"], "future")

    def test_oversized_numeric_lexemes_are_rejected_before_conversion(self):
        integer = "1" * (pi_bridge.MAX_JSON_NUMBER_LENGTH + 1)
        exponent = "1e" + "1" * (pi_bridge.MAX_JSON_NUMBER_LENGTH + 1)
        config_path = self.pi_home / "token-optimizer" / "config.json"

        for lexeme in (integer, exponent):
            with self.subTest(source="request", lexeme=lexeme[:2]):
                payload = json.dumps(self.request(), separators=(",", ":")).replace(
                    '"protocolVersion":1',
                    '"protocolVersion":' + lexeme,
                )
                response, _stderr = self.invoke_raw(payload)
                self.assertEqual(response["errorCode"], "invalid_json")

            with self.subTest(source="config", lexeme=lexeme[:2]):
                config_path.write_text(
                    '{"schemaVersion":' + lexeme + "}", encoding="utf-8"
                )
                response, _stderr = self.invoke(self.request())
                self.assertEqual(response["data"]["config"]["state"], "malformed")

    def test_unknown_version_and_action_return_stable_errors_without_engine_import(self):
        requests = (
            ({**self.request(), "protocolVersion": 2}, "unsupported_protocol"),
            ({**self.request(), "action": "install"}, "unknown_action"),
            ({**self.request(), "action": "measure"}, "unknown_action"),
        )
        real_import = __import__

        def guarded_import(name, *args, **kwargs):
            if name in {"measure", "runtime_env"}:
                raise AssertionError("optimizer engine imported")
            return real_import(name, *args, **kwargs)

        for request, code in requests:
            with self.subTest(code=code):
                output = io.StringIO()
                errors = io.StringIO()
                with mock.patch("builtins.__import__", side_effect=guarded_import):
                    with mock.patch.dict(os.environ, {}, clear=True):
                        self.assertEqual(
                            pi_bridge.main(io.StringIO(json.dumps(request)), output, errors),
                            0,
                        )
                self.assertEqual(json.loads(output.getvalue())["errorCode"], code)

    def test_pre_tool_engine_import_failure_fails_open(self):
        self.grant_consent()
        request = self.action_request("pre_tool")
        with (
            mock.patch.object(
                pi_bridge,
                "_engine_module",
                side_effect=ImportError("simulated engine failure"),
            ),
            mock.patch.dict(os.environ, self.environment, clear=True),
        ):
            output = io.StringIO()
            errors = io.StringIO()
            self.assertEqual(
                pi_bridge.main(io.StringIO(json.dumps(request)), output, errors),
                0,
            )
        self.assertEqual(json.loads(output.getvalue()), {
            "protocolVersion": 1,
            "ok": True,
            "decision": "allow",
        })
        self.assertNotIn("Traceback", output.getvalue())
        self.assertNotIn("Traceback", errors.getvalue())

    def test_all_activity_actions_are_inactive_before_consent(self):
        for action in ACTIVITY_ACTIONS:
            with self.subTest(action=action):
                response, _stderr = self.invoke(self.action_request(action))
                self.assertEqual(response, {
                    "protocolVersion": 1,
                    "ok": True,
                    "data": {
                        "active": False,
                        "reason": "consent_required",
                        "configState": "missing",
                    },
                })

    def test_all_activity_actions_are_inactive_while_disabled(self):
        self.grant_consent(enabled=False)
        for action in ACTIVITY_ACTIONS:
            with self.subTest(action=action):
                response, _stderr = self.invoke(self.action_request(action))
                self.assertEqual(response["data"], {
                    "active": False,
                    "reason": "disabled",
                    "configState": "valid",
                })

    def test_remaining_future_actions_are_not_implemented_only_after_config_gate(self):
        self.grant_consent()
        for action in (
            action for action in ACTIVITY_ACTIONS
            if action not in {
                "pre_tool",
                "post_tool",
                "before_prompt",
                "session_start",
                "pre_compact",
                "post_compact",
            }
        ):
            with self.subTest(action=action):
                response, _stderr = self.invoke(self.action_request(action))
                self.assertEqual(response, {
                    "protocolVersion": 1,
                    "ok": False,
                    "errorCode": "not_implemented",
                })

    def test_malformed_missing_and_future_config_fail_closed(self):
        config_path = self.pi_home / "token-optimizer" / "config.json"
        cases = (
            ("{", "malformed"),
            (json.dumps([]), "malformed"),
            (json.dumps({"schemaVersion": True}), "malformed"),
            (json.dumps({"schemaVersion": 2, "enabled": True}), "future"),
            (json.dumps({"enabled": "yes"}), "malformed"),
            (json.dumps({"consent": {"granted": True, "noticeVersion": "1"}}), "malformed"),
            (json.dumps({
                "schemaVersion": 1,
                "enabled": True,
                "consent": {
                    "granted": True,
                    "noticeVersion": 1,
                    "grantedAt": "not-a-date",
                },
            }), "malformed"),
        )
        for raw, state in cases:
            with self.subTest(state=state, raw=raw[:40]):
                config_path.write_text(raw, encoding="utf-8")
                response, _stderr = self.invoke(self.action_request("dashboard"))
                self.assertEqual(response["data"], {
                    "active": False,
                    "reason": "config_invalid",
                    "configState": state,
                })

        config_path.unlink()
        response, _stderr = self.invoke(self.action_request("dashboard"))
        self.assertEqual(response["data"]["configState"], "missing")

    def test_config_migration_matches_typescript_activation_semantics(self):
        self.write_config({
            "schemaVersion": 0,
            "consent": {
                "granted": True,
                "noticeVersion": 0,
                "grantedAt": "2026-09-03T12:00:00.000Z",
            },
        })
        response, _stderr = self.invoke(self.request())
        self.assertEqual(response["data"]["config"], {
            "state": "valid",
            "enabled": True,
            "consentGranted": False,
            "noticeVersion": 1,
        })

        self.grant_consent()
        response, _stderr = self.invoke(self.request())
        self.assertTrue(response["data"]["active"])

    def test_symlinked_home_data_or_config_is_rejected_without_following_it(self):
        outside = self.root / "outside"
        outside.mkdir()
        linked_home = self.root / "linked-home"
        linked_home.symlink_to(self.pi_home, target_is_directory=True)
        environment = dict(self.environment, TOKEN_OPTIMIZER_PI_HOME=str(linked_home))
        response, _stderr = self.invoke(self.request(), environment)
        self.assertEqual(response["errorCode"], "invalid_environment")

        config_path = self.pi_home / "token-optimizer" / "config.json"
        outside_config = outside / "config.json"
        outside_config.write_text(json.dumps({
            "schemaVersion": 1,
            "enabled": True,
            "consent": {"granted": True, "noticeVersion": 1},
        }), encoding="utf-8")
        config_path.symlink_to(outside_config)
        response, _stderr = self.invoke(self.action_request("pre_compact"))
        self.assertEqual(response["data"], {
            "active": False,
            "reason": "config_invalid",
            "configState": "malformed",
        })
        self.assertEqual(outside_config.read_text(encoding="utf-8"), json.dumps({
            "schemaVersion": 1,
            "enabled": True,
            "consent": {"granted": True, "noticeVersion": 1},
        }))

    def test_request_shape_and_action_specific_fields_mirror_typescript(self):
        tool = {
            "id": "tool-1",
            "name": "bash",
            "kind": "builtin",
            "input": {"command": "printf ok"},
        }
        invalid = [
            None,
            [],
            {**self.request(), "unexpected": True},
            {**self.request(), "protocolVersion": True},
            {**self.request(), "session": {**self.session, "extra": True}},
            {**self.request(), "session": {**self.session, "id": "../session"}},
            {**self.request(), "session": {**self.session, "cwd": ""}},
            {**self.request(), "tool": tool},
            {**self.request(), "tool": None},
            self.request("pre_tool"),
            {**self.request("post_tool"), "tool": tool},
            {**self.request("before_prompt"), "args": {}},
            {
                **self.request("rollup"),
                "session": {"id": "session-1", "cwd": str(self.root)},
            },
            {**self.request("expand"), "args": {"archiveId": "../archive"}},
            {**self.request("expand"), "args": {"archiveId": "archive_1", "offset": None}},
            {**self.request("expand"), "args": {"archiveId": "archive_1", "offset": True}},
            {**self.request("expand"), "args": {"archiveId": "archive_1", "limit": None}},
            {**self.request("expand"), "args": {"archiveId": "archive_1", "limit": 2_001}},
            {
                **self.request("post_tool"),
                "tool": tool,
                "args": {
                    "text": "ok",
                    "isError": False,
                    "hasImages": False,
                    "fullOutputPath": None,
                },
            },
            {
                **self.request("post_tool"),
                "tool": {**tool, "kind": "external"},
                "args": {
                    "text": "ok",
                    "isError": False,
                    "hasImages": False,
                    "fullOutputPath": str(self.root / "output"),
                },
            },
        ]
        for index, request in enumerate(invalid):
            with self.subTest(index=index):
                response, _stderr = self.invoke(request)
                self.assertEqual(response["errorCode"], "invalid_request")

    def test_nested_json_depth_count_key_and_string_limits_are_enforced(self):
        nested = "leaf"
        for _depth in range(20):
            nested = {"nested": nested}
        values = (
            nested,
            [None] * 10_001,
            {str(index): None for index in range(1_001)},
            {"é" * 129: None},
            {"text": "x" * (5 * 1024 * 1024 + 1)},
        )
        for index, value in enumerate(values):
            with self.subTest(index=index):
                request = self.request()
                request["args"] = value
                response, _stderr = self.invoke(request)
                self.assertEqual(response["errorCode"], "invalid_request")

        request = self.request()
        request["session"]["cwd"] = "é" * 2_049
        response, _stderr = self.invoke(request)
        self.assertEqual(response["errorCode"], "invalid_request")

    def test_main_uses_text_encoder_sizes_for_escaped_surrogates(self):
        cases = (
            ("a" * 4_093 + "SURROGATE", "\\ud800", True),
            ("a" * 4_094 + "SURROGATE", "\\ud800", False),
            ("a" * 4_092 + "SURROGATE", "\\ud83d\\ude00", True),
            ("a" * 4_093 + "SURROGATE", "\\ud83d\\ude00", False),
        )
        for cwd, escape, accepted in cases:
            with self.subTest(escape=escape, accepted=accepted):
                request = self.request()
                request["session"]["cwd"] = cwd
                payload = json.dumps(request, separators=(",", ":")).replace(
                    "SURROGATE",
                    escape,
                )
                response, _stderr = self.invoke_raw(payload)
                self.assertEqual(response["ok"], accepted)
                if not accepted:
                    self.assertEqual(response["errorCode"], "invalid_request")

        request = self.request()
        request["session"]["file"] = "SURROGATE"
        payload = json.dumps(request, separators=(",", ":")).replace(
            "SURROGATE",
            "\\ud800",
        )
        response, _stderr = self.invoke_raw(payload)
        self.assertTrue(response["ok"])
        self.assertEqual(response["data"]["paths"]["sessionFile"], "\ud800")

        output = io.StringIO()
        errors = io.StringIO()
        with mock.patch.dict(os.environ, self.environment, clear=True):
            result = pi_bridge.main(io.StringIO(payload), output, errors)
            session_file = os.environ["PI_SESSION_FILE"]
        self.assertEqual(result, 0)
        response = json.loads(output.getvalue())
        self.assertTrue(response["ok"])
        self.assertEqual(response["data"]["paths"]["sessionFile"], "\ud800")
        self.assertEqual(session_file, "\ufffd")
        self.assertNotEqual(response.get("errorCode"), "internal_error")

    def test_stdin_is_bounded_and_contains_exactly_one_json_request(self):
        valid = json.dumps(self.request(), separators=(",", ":"))
        cases = (
            (b"", "invalid_request"),
            (b"{", "invalid_json"),
            (b"\xff", "invalid_request"),
            ((valid + valid).encode("utf-8"), "invalid_json"),
            ((" " * (pi_bridge.MAX_REQUEST_BYTES + 1)).encode("utf-8"), "request_too_large"),
            (b'{"protocolVersion":1,"action":"status","session":{"id":"session-1",'
             b'"cwd":"/tmp"},"args":{"number":NaN}}', "invalid_json"),
        )
        for payload, code in cases:
            with self.subTest(code=code, size=len(payload)):
                response, _stderr = self.invoke_raw(payload)
                self.assertEqual(response["errorCode"], code)

    def test_oversized_aggregate_request_is_rejected(self):
        large = "x" * (3 * 1024 * 1024)
        request = self.request()
        request["args"] = {"first": large, "second": large}
        response, _stderr = self.invoke(request)
        self.assertEqual(response["errorCode"], "request_too_large")

    def test_invalid_input_uses_stderr_for_diagnostics_and_never_stdout_text(self):
        response, stderr = self.invoke_raw("{")
        self.assertEqual(response, {
            "protocolVersion": 1,
            "ok": False,
            "errorCode": "invalid_json",
        })
        self.assertTrue(stderr.strip())
        self.assertNotIn("{", stderr)

    def test_no_general_engine_or_cli_dispatch_surface_is_exposed(self):
        source = BRIDGE.read_text(encoding="utf-8")
        for forbidden in (
            "measure.doctor",
            "runpy",
            "subprocess",
            "import_module",
            "exec(",
            "eval(",
        ):
            self.assertNotIn(forbidden, source)
        for action in ("install", "daemon", "ensure_health", "run_module", "cli"):
            request = self.request()
            request["action"] = action
            response, _stderr = self.invoke(request)
            self.assertEqual(response["errorCode"], "unknown_action")

    def test_foreign_host_sentinels_are_unchanged_for_every_action(self):
        sentinels = {}
        for name in (".claude", ".codex", ".hermes", ".copilot", ".cursor"):
            path = self.root / name
            path.mkdir()
            sentinel = path / "sentinel.json"
            sentinel.write_text('{"owner":"foreign"}', encoding="utf-8")
            sentinels[sentinel] = sentinel.read_bytes()
        opencode = self.root / ".config" / "opencode"
        opencode.mkdir(parents=True)
        opencode_sentinel = opencode / "sentinel.json"
        opencode_sentinel.write_text('{"owner":"foreign"}', encoding="utf-8")
        sentinels[opencode_sentinel] = opencode_sentinel.read_bytes()

        self.grant_consent()
        for action in ("status", "doctor") + ACTIVITY_ACTIONS:
            request = (
                self.request(action)
                if action in {"status", "doctor"}
                else self.action_request(action)
            )
            response, _stderr = self.invoke(request)
            self.assertIn("ok", response)
        for path, expected in sentinels.items():
            self.assertEqual(path.read_bytes(), expected, str(path))


if __name__ == "__main__":
    unittest.main()
