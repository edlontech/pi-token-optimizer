import hashlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
from python import pi_bridge

ROOT = Path(__file__).parents[2]
BRIDGE = ROOT / "python" / "pi_bridge.py"


class PiBridgeToolTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name).resolve()
        self.pi_home = self.root / "pi-home"
        self.data_root = self.pi_home / "token-optimizer" / "data"
        self.data_root.mkdir(parents=True)
        config = self.pi_home / "token-optimizer" / "config.json"
        config.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "enabled": True,
                    "consent": {
                        "granted": True,
                        "noticeVersion": 1,
                        "grantedAt": "2026-09-03T12:00:00.000Z",
                    },
                }
            ),
            encoding="utf-8",
        )
        self.environment = {
            "HOME": str(self.root),
            "PATH": os.environ.get("PATH", ""),
            "PYTHONDONTWRITEBYTECODE": "1",
            "TOKEN_OPTIMIZER_PI_HOME": str(self.pi_home),
            "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            "TOKEN_OPTIMIZER_FIRST_READ_SHADOW": "0",
        }

    def request(self, name, kind, tool_input, tool_id="tool-1"):
        return {
            "protocolVersion": 1,
            "action": "pre_tool",
            "session": {"id": "session-1", "cwd": str(self.root)},
            "tool": {
                "id": tool_id,
                "name": name,
                "kind": kind,
                "input": tool_input,
            },
        }

    def post_request(
        self,
        name,
        kind,
        tool_input,
        text,
        *,
        tool_id="tool-1",
        is_error=False,
        has_images=False,
        full_output_path=None,
    ):
        request = self.request(name, kind, tool_input, tool_id)
        request["action"] = "post_tool"
        request["args"] = {
            "text": text,
            "isError": is_error,
            "hasImages": has_images,
        }
        if full_output_path is not None:
            request["args"]["fullOutputPath"] = str(full_output_path)
        return request

    def invoke(self, request, environment=None):
        completed = subprocess.run(
            [sys.executable, str(BRIDGE)],
            input=json.dumps(request).encode("utf-8"),
            capture_output=True,
            cwd=self.root,
            env=self.environment if environment is None else environment,
            check=False,
        )
        self.assertEqual(
            completed.returncode, 0, completed.stderr.decode("utf-8", "replace")
        )
        stdout = completed.stdout.decode("utf-8", "strict")
        self.assertEqual(len(stdout.splitlines()), 1, stdout)
        return json.loads(stdout), completed.stderr.decode("utf-8", "replace")

    def test_eligible_bash_is_rewritten_and_excluded_bash_is_unchanged(self):
        response, stderr = self.invoke(
            self.request("bash", "builtin", {"command": "git status", "timeout": 30})
        )

        self.assertTrue(response["ok"])
        self.assertEqual(response["decision"], "allow")
        self.assertEqual(set(response["updatedInput"]), {"command"})
        rewritten = response["updatedInput"]["command"]
        self.assertTrue(rewritten.startswith("for b in bash "))
        self.assertTrue(rewritten.endswith("; done; git status"))
        self.assertIn("PI_SESSION_ID=session-1", rewritten)
        self.assertEqual(stderr, "")

        for command in ("git status | cat", "git commit -m nope", 42):
            with self.subTest(command=command):
                response, _stderr = self.invoke(
                    self.request("bash", "builtin", {"command": command})
                )
                self.assertEqual(
                    response,
                    {
                        "protocolVersion": 1,
                        "ok": True,
                        "decision": "allow",
                    },
                )

    def test_read_honors_project_contextignore(self):
        ignored = self.root / "ignored.py"
        ignored.write_text("print('secret')\n", encoding="utf-8")
        (self.root / ".contextignore").write_text("ignored.py\n", encoding="utf-8")

        response, stderr = self.invoke(
            self.request("read", "builtin", {"path": str(ignored)})
        )

        self.assertEqual(response["decision"], "block")
        self.assertEqual(
            response["data"]["reason"],
            "Blocked by .contextignore: ignored.py",
        )
        self.assertNotIn("additionalContext", response["data"])
        self.assertEqual(stderr, "")

    def test_read_substitutes_unchanged_rereads_then_uses_escape_hatch(self):
        source = self.root / "sample.py"
        source.write_text(
            "\n\n".join(
                f"def function_{index}(value):\n    return value + {index}"
                for index in range(120)
            ),
            encoding="utf-8",
        )

        first, _stderr = self.invoke(
            self.request("read", "builtin", {"path": str(source)}, "read-1")
        )
        second, _stderr = self.invoke(
            self.request("read", "builtin", {"path": str(source)}, "read-2")
        )
        third, _stderr = self.invoke(
            self.request("read", "builtin", {"path": str(source)}, "read-3")
        )
        fourth, _stderr = self.invoke(
            self.request("read", "builtin", {"path": str(source)}, "read-4")
        )

        self.assertEqual(first["decision"], "allow")
        self.assertEqual(second["decision"], "block")
        self.assertIn("signatures view", second["data"]["reason"])
        self.assertIn("python signatures", second["data"]["additionalContext"])
        self.assertEqual(third["decision"], "block")
        self.assertNotIn("additionalContext", third["data"])
        self.assertEqual(
            fourth,
            {
                "protocolVersion": 1,
                "ok": True,
                "decision": "allow",
            },
        )

    def test_read_returns_changed_file_delta_and_allows_specific_range(self):
        source = self.root / "changed.py"
        original = "\n\n".join(
            f"def function_{index}(value):\n    return value + {index}"
            for index in range(120)
        )
        source.write_text(original, encoding="utf-8")
        first, _stderr = self.invoke(
            self.request("read", "builtin", {"path": str(source)}, "read-1")
        )
        self.assertEqual(first["decision"], "allow")

        source.write_text(
            original.replace("return value + 50", "return value + 5000"),
            encoding="utf-8",
        )
        current = source.stat()
        os.utime(
            source,
            ns=(current.st_atime_ns, current.st_mtime_ns + 1_000_000),
        )
        changed, _stderr = self.invoke(
            self.request("read", "builtin", {"path": str(source)}, "read-2")
        )
        ranged, _stderr = self.invoke(
            self.request(
                "read",
                "builtin",
                {"path": str(source), "offset": 1, "limit": 5},
                "read-3",
            )
        )

        self.assertEqual(changed["decision"], "block")
        self.assertIn("showing diff", changed["data"]["reason"])
        self.assertIn("+    return value + 5000", changed["data"]["additionalContext"])
        self.assertEqual(ranged["decision"], "allow")

    def test_external_exact_refetch_is_blocked_but_unknown_calls_are_unchanged(self):
        tool_name = "acme.search"
        tool_input = {"query": "needle", "page": 1}
        normalized = json.dumps(
            tool_input,
            sort_keys=True,
            ensure_ascii=False,
            default=str,
        )
        fingerprint = hashlib.sha256(f"{tool_name}\0{normalized}".encode()).hexdigest()[
            :16
        ]
        archive = self.data_root / "tool-archive" / "session-1"
        archive.mkdir(parents=True)
        (archive / "archived-1.json").write_text(
            json.dumps({"response": "saved result"}),
            encoding="utf-8",
        )
        (archive / "manifest.jsonl").write_text(
            json.dumps(
                {
                    "tool_name": tool_name,
                    "tool_use_id": "archived-1",
                    "args_hash": fingerprint,
                    "tokens_est": 2000,
                }
            )
            + "\n",
            encoding="utf-8",
        )

        blocked, stderr = self.invoke(
            self.request(tool_name, "external", tool_input, "external-2")
        )
        novel, _stderr = self.invoke(
            self.request(tool_name, "external", {"query": "new"}, "external-3")
        )
        unknown, _stderr = self.invoke(
            self.request("future_builtin", "builtin", {"value": 1}, "unknown-1")
        )

        self.assertEqual(blocked["decision"], "block")
        self.assertIn("archived-1", blocked["data"]["reason"])
        self.assertIn("measure.py expand archived-1", blocked["data"]["reason"])
        self.assertEqual(stderr, "")
        expected = {"protocolVersion": 1, "ok": True, "decision": "allow"}
        self.assertEqual(novel, expected)
        self.assertEqual(unknown, expected)

    def test_engine_failures_and_sqlite_contention_fail_open_once(self):
        request = self.request("bash", "builtin", {"command": "git status"})
        for engine_output in ("not json", '{"hookSpecificOutput":{}} trailing'):
            with self.subTest(engine_output=engine_output):
                output = io.StringIO()
                errors = io.StringIO()
                with (
                    mock.patch.dict(os.environ, self.environment, clear=True),
                    mock.patch.object(
                        pi_bridge, "_capture_hook", return_value=engine_output
                    ),
                    mock.patch("sys.stderr", errors),
                ):
                    pi_bridge.main(io.StringIO(json.dumps(request)), output, errors)
                self.assertEqual(
                    json.loads(output.getvalue()),
                    {
                        "protocolVersion": 1,
                        "ok": True,
                        "decision": "allow",
                    },
                )
                self.assertEqual(len(output.getvalue().splitlines()), 1)
                self.assertLessEqual(len(errors.getvalue()), 600)

        def noisy_failure(_name):
            print('{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}')
            raise SystemExit(1)

        output = io.StringIO()
        errors = io.StringIO()
        leaked = io.StringIO()
        external = self.request("acme.search", "external", {"query": "needle"})
        with (
            mock.patch.dict(os.environ, self.environment, clear=True),
            mock.patch.object(pi_bridge, "_engine_module", side_effect=noisy_failure),
            mock.patch("sys.stdout", leaked),
        ):
            pi_bridge.main(io.StringIO(json.dumps(external)), output, errors)
        self.assertEqual(
            json.loads(output.getvalue()),
            {
                "protocolVersion": 1,
                "ok": True,
                "decision": "allow",
            },
        )
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertEqual(leaked.getvalue(), "")
        self.assertLessEqual(len(errors.getvalue()), 600)

        source = self.root / "locked.py"
        source.write_text("print('locked')\n", encoding="utf-8")
        first, _stderr = self.invoke(
            self.request("read", "builtin", {"path": str(source)}, "locked-1")
        )
        self.assertEqual(first["decision"], "allow")
        database = self.data_root / "session-store" / "session-1.db"
        connection = sqlite3.connect(str(database))
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "UPDATE file_reads SET read_count = read_count WHERE file_path = ?",
                (str(source),),
            )
            locked, stderr = self.invoke(
                self.request("read", "builtin", {"path": str(source)}, "locked-2")
            )
        finally:
            connection.rollback()
            connection.close()
        self.assertEqual(
            locked,
            {
                "protocolVersion": 1,
                "ok": True,
                "decision": "allow",
            },
        )
        self.assertLessEqual(len(stderr), 600)

    def test_post_tool_errors_images_and_binary_text_pass_through_without_persistence(
        self,
    ):
        cases = (
            {"text": "failure\n" * 1000, "is_error": True},
            {"text": "image metadata\n" * 1000, "has_images": True},
            {"text": "prefix\x00binary\n" * 1000},
        )
        for index, options in enumerate(cases):
            with self.subTest(index=index):
                request = self.post_request(
                    "acme.search",
                    "external",
                    {"query": "needle"},
                    tool_id=f"unsafe-{index}",
                    **options,
                )
                response, stderr = self.invoke(request)
                self.assertEqual(
                    response,
                    {
                        "protocolVersion": 1,
                        "ok": True,
                        "decision": "allow",
                    },
                )
                self.assertEqual(stderr, "")
        self.assertFalse((self.data_root / "tool-archive").exists())
        self.assertFalse((self.data_root / "session-store").exists())

    def test_edit_and_write_refresh_read_cache_and_compaction_still_clears_it(self):
        read_cache = pi_bridge.SCRIPTS_PATH / "read_cache.py"
        for tool_name in ("edit", "write"):
            with self.subTest(tool_name=tool_name):
                source = self.root / f"{tool_name}_target.py"
                original = "\n\n".join(
                    f"def old_marker_{index}(value):\n    return value + {index}"
                    for index in range(120)
                )
                changed = original.replace("old_marker_0", "new_marker_0")
                source.write_text(original, encoding="utf-8")

                first, _stderr = self.invoke(
                    self.request(
                        "read", "builtin", {"path": str(source)}, f"{tool_name}-read-1"
                    )
                )
                self.assertEqual(first["decision"], "allow")

                source.write_text(changed, encoding="utf-8")
                post, stderr = self.invoke(
                    self.post_request(
                        tool_name,
                        "builtin",
                        {"path": str(source)},
                        "success",
                        tool_id=f"{tool_name}-1",
                    )
                )
                reread, _stderr = self.invoke(
                    self.request(
                        "read", "builtin", {"path": str(source)}, f"{tool_name}-read-2"
                    )
                )

                self.assertEqual(
                    post,
                    {
                        "protocolVersion": 1,
                        "ok": True,
                        "decision": "allow",
                    },
                )
                self.assertEqual(stderr, "")
                self.assertEqual(reread["decision"], "block")
                self.assertIn("signatures view", reread["data"]["reason"])
                self.assertIn("new_marker_0", reread["data"]["additionalContext"])
                self.assertNotIn(
                    "old_marker_0(value)", reread["data"]["additionalContext"]
                )

                cleared = subprocess.run(
                    [sys.executable, str(read_cache), "--clear-compacted", "--quiet"],
                    input=json.dumps({"session_id": "session-1"}).encode("utf-8"),
                    capture_output=True,
                    cwd=self.root,
                    env=dict(
                        self.environment,
                        TOKEN_OPTIMIZER_RUNTIME="pi",
                        TOKEN_OPTIMIZER_SNAPSHOT_DIR=str(self.data_root),
                        PI_SESSION_ID="session-1",
                    ),
                    check=False,
                )
                self.assertEqual(
                    cleared.returncode, 0, cleared.stderr.decode("utf-8", "replace")
                )
                after_compaction, _stderr = self.invoke(
                    self.request(
                        "read", "builtin", {"path": str(source)}, f"{tool_name}-read-3"
                    )
                )
                self.assertEqual(after_compaction["decision"], "allow")

    def test_external_text_is_archived_replaced_and_returns_expand_id(self):
        text = "result line with useful detail\n" * 300
        response, stderr = self.invoke(
            self.post_request(
                "acme.search",
                "external",
                {"query": "needle"},
                text,
                tool_id="external-1",
            )
        )

        self.assertEqual(response["archiveId"], "external-1")
        self.assertIn("Full result archived", response["replacementText"])
        self.assertIn("measure.py expand external-1", response["replacementText"])
        self.assertLess(len(response["replacementText"]), len(text))
        archive = self.data_root / "tool-archive" / "session-1"
        entry = json.loads((archive / "external-1.json").read_text(encoding="utf-8"))
        self.assertEqual(entry["tool_name"], "acme.search")
        self.assertEqual(entry["tool_kind"], "external")
        manifest = (archive / "manifest.jsonl").read_text(encoding="utf-8")
        self.assertIn('"tool_use_id": "external-1"', manifest)
        self.assertEqual(stderr, "")

    def test_external_replacement_is_bound_to_current_verified_archive(self):
        archive = self.data_root / "tool-archive" / "session-1"
        archive.mkdir(parents=True)
        request = self.post_request(
            "acme.search",
            "external",
            {"query": "current"},
            "current result\n" * 500,
            tool_id="current-1",
        )

        def pointer(archive_id):
            return (
                "preview\n\n[Full result archived (7,500 chars) — saved to disk, not lost.\n"
                "Do NOT call acme.search again to get this data — read the saved copy by "
                "running this in Bash:\n"
                f"    python3 {pi_bridge.MEASURE_PATH} expand {archive_id}]"
            )

        def invoke_result(archive_id, replacement, entry_kind, manifest_kind):
            (archive / f"{archive_id}.json").write_text(
                json.dumps(
                    {
                        "tool_use_id": archive_id,
                        "tool_name": "acme.search",
                        "tool_kind": entry_kind,
                        "response": "saved result",
                    }
                ),
                encoding="utf-8",
            )
            (archive / "manifest.jsonl").write_text(
                json.dumps(
                    {
                        "tool_use_id": archive_id,
                        "tool_name": "acme.search",
                        "tool_kind": manifest_kind,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            result = {
                "archive_id": archive_id,
                "replacement_text": replacement,
                "metadata": {
                    "tool_use_id": archive_id,
                    "tool_name": "acme.search",
                    "tool_kind": "external",
                },
            }
            module = types.SimpleNamespace(
                archive_result=mock.Mock(return_value=result)
            )
            real_load = pi_bridge._load_engine

            def load(name):
                return module if name == "archive_result" else real_load(name)

            output = io.StringIO()
            with (
                mock.patch.dict(os.environ, self.environment, clear=True),
                mock.patch.object(pi_bridge, "_load_engine", side_effect=load),
                mock.patch.object(pi_bridge, "_best_effort_post_metadata"),
            ):
                pi_bridge.main(io.StringIO(json.dumps(request)), output, io.StringIO())
            return json.loads(output.getvalue())

        allow = {"protocolVersion": 1, "ok": True, "decision": "allow"}
        cases = (
            ("older-1", pointer("older-1"), "external", "external"),
            ("current-1", pointer("current-1"), "builtin", "external"),
            ("current-1", pointer("current-1"), "external", "builtin"),
            (
                "current-1",
                f"arbitrary replacement\n    python3 {pi_bridge.MEASURE_PATH} expand current-1]",
                "external",
                "external",
            ),
        )
        for case in cases:
            with self.subTest(case=case[:2]):
                self.assertEqual(invoke_result(*case), allow)

    def test_external_allowlist_and_retention_prune_do_not_advertise_archive(self):
        text = "result line\n" * 500
        allowlisted = dict(
            self.environment,
            TOKEN_OPTIMIZER_ARCHIVE_EXEMPT_DEFAULTS="off",
            TOKEN_OPTIMIZER_ARCHIVE_EXEMPT_TOOLS="acme.*",
        )
        response, _stderr = self.invoke(
            self.post_request("acme.search", "external", {}, text, tool_id="exempt-1"),
            allowlisted,
        )
        self.assertEqual(
            response,
            {
                "protocolVersion": 1,
                "ok": True,
                "decision": "allow",
            },
        )

        pruned = dict(
            self.environment,
            TOKEN_OPTIMIZER_ARCHIVE_CLEANUP_INTERVAL_SECONDS="0",
            TOKEN_OPTIMIZER_ARCHIVE_RETENTION_MAX_BYTES="1",
        )
        response, _stderr = self.invoke(
            self.post_request("other.search", "external", {}, text, tool_id="pruned-1"),
            pruned,
        )
        self.assertEqual(
            response,
            {
                "protocolVersion": 1,
                "ok": True,
                "decision": "allow",
            },
        )
        self.assertFalse(
            (self.data_root / "tool-archive" / "session-1" / "pruned-1.json").exists()
        )

        shutil_target = self.root / "outside-archive"
        shutil_target.mkdir()
        archive_root = self.data_root / "tool-archive"
        shutil.rmtree(archive_root)
        archive_root.symlink_to(shutil_target, target_is_directory=True)
        response, _stderr = self.invoke(
            self.post_request(
                "other.search",
                "external",
                {},
                text,
                tool_id="failed-1",
            )
        )
        self.assertEqual(
            response,
            {
                "protocolVersion": 1,
                "ok": True,
                "decision": "allow",
            },
        )
        self.assertEqual(list(shutil_target.iterdir()), [])

    def test_bash_success_compresses_only_with_verified_archive(self):
        text = "test_example PASSED\n" * 300 + "300 passed in 1.00s\n"
        response, stderr = self.invoke(
            self.post_request(
                "bash",
                "builtin",
                {"command": "pytest tests/"},
                text,
                tool_id="bash-1",
            )
        )

        self.assertIn("Full result archived", response["replacementText"])
        archive_id = response["archiveId"]
        self.assertRegex(archive_id, r"^[a-f0-9]{16}$")
        self.assertIn("measure.py expand " + archive_id, response["replacementText"])
        archive = self.data_root / "tool-archive" / "session-1"
        self.assertTrue((archive / f"{archive_id}.json").is_file())
        self.assertIn(
            archive_id, (archive / "manifest.jsonl").read_text(encoding="utf-8")
        )
        self.assertEqual(stderr, "")

    def test_bash_uses_safe_full_output_file_and_ignores_unsafe_path(self):
        full_text = "test_from_file PASSED\n" * 300 + "300 passed in 1.00s\n"
        output_path = self.root / "bash-output.txt"
        output_path.write_text(full_text, encoding="utf-8")
        response, _stderr = self.invoke(
            self.post_request(
                "bash",
                "builtin",
                {"command": "pytest tests/"},
                "visible truncation",
                tool_id="bash-file-1",
                full_output_path=output_path,
            )
        )
        self.assertIn(f"{len(full_text):,} chars", response["replacementText"])

        outside = self.root / "outside.txt"
        outside.write_text(full_text, encoding="utf-8")
        symlink = self.root / "linked-output.txt"
        symlink.symlink_to(outside)
        response, _stderr = self.invoke(
            self.post_request(
                "bash",
                "builtin",
                {"command": "pytest tests/"},
                "visible truncation",
                tool_id="bash-file-2",
                full_output_path=symlink,
            )
        )
        self.assertEqual(
            response,
            {
                "protocolVersion": 1,
                "ok": True,
                "decision": "allow",
            },
        )

        unsafe_paths = []
        oversized = self.root / "oversized.txt"
        with oversized.open("wb") as handle:
            handle.truncate(pi_bridge.MAX_TEXT_BYTES + 1)
        unsafe_paths.append(oversized)
        binary = self.root / "binary.txt"
        binary.write_bytes(b"test PASSED\x00\n" * 300)
        unsafe_paths.append(binary)
        if hasattr(os, "mkfifo"):
            fifo = self.root / "output.fifo"
            os.mkfifo(fifo)
            unsafe_paths.append(fifo)

        for index, unsafe_path in enumerate(unsafe_paths, start=3):
            with self.subTest(path=unsafe_path.name):
                response, _stderr = self.invoke(
                    self.post_request(
                        "bash",
                        "builtin",
                        {"command": "pytest tests/"},
                        "visible truncation",
                        tool_id=f"bash-file-{index}",
                        full_output_path=unsafe_path,
                    )
                )
                self.assertEqual(
                    response,
                    {
                        "protocolVersion": 1,
                        "ok": True,
                        "decision": "allow",
                    },
                )

    def test_due_quality_refresh_disables_host_settings_self_heal(self):
        request = self.post_request(
            "acme.search",
            "external",
            {"query": "quality"},
            "success",
            tool_id="quality-external-1",
        )

        with mock.patch.dict(os.environ, self.environment, clear=True):
            pi_bridge._configure_environment(pi_bridge.parse_request(request))
            gate = pi_bridge._load_engine("quality_cache_gate")
            gate._resolve_quality_cache_dir.cache_clear()
            marker = gate._throttle_marker(session_id="session-1")
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.touch()
            os.utime(marker, (0, 0))

            heal = mock.Mock(side_effect=AssertionError("host settings self-heal"))
            setup = mock.Mock(side_effect=AssertionError("host settings write"))
            settings_access = mock.Mock(
                side_effect=AssertionError("host settings access")
            )
            real_read_text = Path.read_text
            real_write_text = Path.write_text

            def guarded_read_text(path, *args, **kwargs):
                if path.name == "settings.json":
                    settings_access(path)
                return real_read_text(path, *args, **kwargs)

            def guarded_write_text(path, *args, **kwargs):
                if path.name == "settings.json":
                    settings_access(path)
                return real_write_text(path, *args, **kwargs)

            quality_cache = mock.Mock()
            measure = types.SimpleNamespace(
                _daemon_midsession_pulse=mock.Mock(),
                quality_cache=quality_cache,
                evaluate_cohort_tripwire=mock.Mock(),
                setup_quality_bar=setup,
            )
            output = io.StringIO()
            errors = io.StringIO()
            with (
                mock.patch.object(gate, "_quality_cache_self_heal", heal),
                mock.patch.object(Path, "read_text", guarded_read_text),
                mock.patch.object(Path, "write_text", guarded_write_text),
                mock.patch.dict(sys.modules, {"measure": measure}),
            ):
                pi_bridge.main(io.StringIO(json.dumps(request)), output, errors)

        self.assertEqual(
            json.loads(output.getvalue()),
            {
                "protocolVersion": 1,
                "ok": True,
                "decision": "allow",
            },
        )
        quality_cache.assert_called_once()
        heal.assert_not_called()
        setup.assert_not_called()
        settings_access.assert_not_called()
        self.assertEqual(errors.getvalue(), "")

    def test_post_tool_malformed_engine_output_fails_open(self):
        request = self.post_request(
            "bash",
            "builtin",
            {"command": "pytest tests/"},
            "test PASSED\n" * 300,
        )
        for engine_output in (
            "not json",
            '{"hookSpecificOutput":{"hookEventName":"PostToolUse"}} trailing',
            '{"hookSpecificOutput":{"hookEventName":"PreToolUse",'
            '"updatedToolOutput":{"stdout":"lossy"}}}',
            json.dumps(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "PostToolUse",
                        "updatedToolOutput": {
                            "stdout": (
                                "lossy\n\n[Full result archived (4,000 chars) — saved to disk, not lost.\n"
                                "Do NOT re-run the original tool to get this data — read the saved copy by running this in Bash:\n"
                                f"    python3 {pi_bridge.MEASURE_PATH} expand missing-1]"
                            ),
                            "stderr": "",
                            "interrupted": False,
                            "isImage": False,
                        },
                    },
                }
            ),
        ):
            with self.subTest(engine_output=engine_output):
                output = io.StringIO()
                errors = io.StringIO()
                with (
                    mock.patch.dict(os.environ, self.environment, clear=True),
                    mock.patch.object(
                        pi_bridge, "_capture_hook", return_value=engine_output
                    ),
                ):
                    pi_bridge.main(io.StringIO(json.dumps(request)), output, errors)
                self.assertEqual(
                    json.loads(output.getvalue()),
                    {
                        "protocolVersion": 1,
                        "ok": True,
                        "decision": "allow",
                    },
                )
                self.assertEqual(len(output.getvalue().splitlines()), 1)
                self.assertLessEqual(len(errors.getvalue()), 600)

    def test_sqlite_contention_cannot_suppress_external_replacement(self):
        database_dir = self.data_root / "session-store"
        database_dir.mkdir(parents=True)
        database = database_dir / "session-1.db"
        connection = sqlite3.connect(str(database))
        try:
            connection.execute("CREATE TABLE blocker (id INTEGER PRIMARY KEY)")
            connection.commit()
            connection.execute("BEGIN EXCLUSIVE")
            response, stderr = self.invoke(
                self.post_request(
                    "acme.search",
                    "external",
                    {"query": "needle"},
                    "result line\n" * 500,
                    tool_id="contended-1",
                )
            )
        finally:
            connection.rollback()
            connection.close()

        self.assertEqual(response["archiveId"], "contended-1")
        self.assertIn("measure.py expand contended-1", response["replacementText"])
        self.assertLessEqual(len(stderr), 600)

    def test_unsupported_post_tool_returns_allow_without_replacement(self):
        response, _stderr = self.invoke(
            self.post_request(
                "future_builtin",
                "builtin",
                {"value": 1},
                "result line\n" * 500,
            )
        )
        self.assertEqual(
            response,
            {
                "protocolVersion": 1,
                "ok": True,
                "decision": "allow",
            },
        )

    def test_config_gate_prevents_every_tool_engine_import(self):
        (self.pi_home / "token-optimizer" / "config.json").unlink()
        requests = (
            self.request("bash", "builtin", {"command": "git status"}),
            self.post_request(
                "acme.search",
                "external",
                {"query": "needle"},
                "result line\n" * 500,
            ),
        )
        for request in requests:
            with self.subTest(action=request["action"]):
                output = io.StringIO()
                errors = io.StringIO()
                with (
                    mock.patch.dict(os.environ, self.environment, clear=True),
                    mock.patch.object(
                        pi_bridge,
                        "_engine_module",
                        side_effect=AssertionError("engine imported"),
                    ) as engine,
                ):
                    pi_bridge.main(io.StringIO(json.dumps(request)), output, errors)

                self.assertEqual(
                    json.loads(output.getvalue())["data"],
                    {
                        "active": False,
                        "reason": "consent_required",
                        "configState": "missing",
                    },
                )
                engine.assert_not_called()
                self.assertEqual(errors.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
