import contextlib
import importlib
import io
import json
import os
import shlex
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).parents[2]
SCRIPTS = ROOT / "vendor" / "token-optimizer" / "skills" / "token-optimizer" / "scripts"
PYTHON = ROOT / "python"
FIXTURES = ROOT / "tests" / "fixtures"
for import_root in (str(SCRIPTS), str(PYTHON)):
    if import_root not in sys.path:
        sys.path.insert(0, import_root)

_VENDOR_MODULES = {
    "archive_result",
    "bash_hook",
    "command_filters",
    "context_pressure",
    "measure",
    "pi_session",
    "plugin_env",
    "runtime_env",
    "session_store",
}


def fresh_import(name):
    for module_name in _VENDOR_MODULES:
        sys.modules.pop(module_name, None)
    importlib.invalidate_caches()
    return importlib.import_module(name)


class PiRuntimeTests(unittest.TestCase):
    def test_pi_runtime_requires_and_uses_only_its_configured_home(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi home"
            pi_home.mkdir()
            foreign = root / ".claude"
            foreign.mkdir()
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                "CLAUDE_CONFIG_DIR": str(foreign),
                "CODEX_HOME": str(root / ".codex"),
                "HERMES_HOME": str(root / ".hermes"),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                runtime_env = fresh_import("runtime_env")
                self.assertEqual(runtime_env.detect_runtime(), "pi")
                self.assertEqual(runtime_env.runtime_home(), pi_home.resolve())
                self.assertEqual(runtime_env.runtime_name_for_humans(), "Pi")
                self.assertEqual(
                    runtime_env.plugin_data_env_vars(),
                    ("TOKEN_OPTIMIZER_PLUGIN_DATA",),
                )

            env.pop("TOKEN_OPTIMIZER_PI_HOME")
            with mock.patch.dict(os.environ, env, clear=True):
                runtime_env = fresh_import("runtime_env")
                self.assertEqual(runtime_env.detect_runtime(), "pi")
                with self.assertRaises(RuntimeError):
                    runtime_env.runtime_home()

    def test_tool_call_thresholds_use_base_when_context_window_is_unavailable_or_nonpositive(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi"
            pi_home.mkdir()
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                measure = fresh_import("measure")
                self.assertEqual(
                    (measure._TOOL_CALL_WARN, measure._TOOL_CALL_CRITICAL),
                    (25, 40),
                )
                for context_window in (None, 0, -1):
                    with self.subTest(context_window=context_window):
                        with mock.patch.object(
                            measure,
                            "detect_context_window",
                            return_value=(context_window, "unavailable"),
                        ):
                            self.assertEqual(
                                measure._scaled_tool_call_thresholds(),
                                (25, 40),
                            )

    def test_measure_delegates_every_pi_session_parser_seam(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            session = root / "session.jsonl"
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", session)
            snapshot = root / "pi" / "token-optimizer" / "data"
            snapshot.mkdir(parents=True)
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(root / "pi"),
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(snapshot),
                "PI_CODING_AGENT_SESSION_DIR": str(root),
                "PI_SESSION_FILE": str(session),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                measure = fresh_import("measure")
                adapter = mock.Mock()
                adapter.is_pi_session_path.return_value = True
                adapter.find_all_jsonl_files.return_value = [(session, 1.0, "project")]
                adapter.find_current_session_jsonl.return_value = session
                adapter.find_session_jsonl_by_id.return_value = session
                adapter.parse_session_jsonl.return_value = {"runtime": "pi"}
                adapter.parse_session_turns.return_value = [{"model": "pi-model"}]
                adapter.parse_jsonl_for_quality.return_value = {"messages": []}
                adapter.extract_session_state.return_value = {"active_files": []}
                adapter.iter_tool_outputs.return_value = [{"tool_name": "external"}]
                measure.pi_session = adapter

                self.assertEqual(
                    measure._find_all_jsonl_files(7), [(session, 1.0, "project")]
                )
                self.assertEqual(measure._find_current_session_jsonl(), session)
                self.assertEqual(
                    measure._find_session_jsonl_by_id("session-id"), session
                )
                self.assertEqual(
                    measure._parse_session_jsonl(session), {"runtime": "pi"}
                )
                self.assertEqual(
                    measure.parse_session_turns(session), [{"model": "pi-model"}]
                )
                self.assertEqual(
                    measure._parse_jsonl_for_quality(session), {"messages": []}
                )
                self.assertEqual(
                    measure._extract_session_state(session), {"active_files": []}
                )
                self.assertEqual(
                    measure._iter_tool_outputs(session),
                    [{"tool_name": "external"}],
                )

                adapter.find_all_jsonl_files.assert_called_with(7)
                adapter.find_current_session_jsonl.assert_called_once_with()
                adapter.find_session_jsonl_by_id.assert_called_once_with("session-id")
                adapter.parse_session_jsonl.assert_called_once_with(session)
                adapter.parse_session_turns.assert_called_once_with(session)
                adapter.parse_jsonl_for_quality.assert_called_once_with(session)
                adapter.extract_session_state.assert_called_once_with(
                    session,
                    tail_lines=500,
                    max_files=measure._CHECKPOINT_MAX_FILES,
                )
                adapter.iter_tool_outputs.assert_called_once_with(
                    session,
                    min_chars=4096,
                    max_outputs=20,
                )

    def test_pi_static_dashboard_is_host_isolated_and_neutral(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi"
            snapshot = pi_home / "token-optimizer" / "data"
            snapshot.mkdir(parents=True)
            session = root / "pi-session.jsonl"
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", session)
            foreign_paths = {
                root / ".claude.json",
                root / ".claude",
                root / ".codex",
                root / ".hermes",
                root / "project" / ".claude",
            }
            for path in foreign_paths:
                if path.suffix:
                    path.write_text('{"sentinel":"foreign"}', encoding="utf-8")
                else:
                    path.mkdir(parents=True)
                    (path / "settings.json").write_text(
                        '{"sentinel":"foreign"}',
                        encoding="utf-8",
                    )
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(snapshot),
                "PI_CODING_AGENT_SESSION_DIR": str(root),
                "PI_SESSION_FILE": str(session),
                "CLAUDE_CONFIG_DIR": str(root / ".claude"),
                "CODEX_HOME": str(root / ".codex"),
                "HERMES_HOME": str(root / ".hermes"),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            expected = pi_home.resolve() / "token-optimizer" / "dashboard.html"
            legacy = (
                pi_home.resolve() / "_backups" / "token-optimizer" / "dashboard.html"
            )

            with mock.patch.dict(os.environ, env, clear=True):
                measure = fresh_import("measure")
                parsed = measure.pi_session.parse_session_jsonl(session)
                self.assertIsNotNone(parsed)
                assert parsed is not None
                conn = measure._init_trends_db()
                try:
                    self.assertTrue(
                        measure._insert_normalized_session(
                            conn,
                            parsed,
                            session_key="pi:33333333-3333-4333-8333-333333333333",
                            project_name="pi-project",
                            incomplete=False,
                        )
                    )
                    conn.commit()
                finally:
                    conn.close()

                blocked = mock.Mock(
                    side_effect=AssertionError("foreign dashboard helper called")
                )
                real_open = open
                real_path_open = Path.open

                def reject_foreign(path):
                    candidate = Path(path)
                    if any(
                        candidate == foreign or foreign in candidate.parents
                        for foreign in foreign_paths
                    ):
                        raise AssertionError(
                            f"foreign dashboard path read: {candidate}"
                        )

                def guarded_open(path, *args, **kwargs):
                    reject_foreign(path)
                    return real_open(path, *args, **kwargs)

                def guarded_path_open(path, *args, **kwargs):
                    reject_foreign(path)
                    return real_path_open(path, *args, **kwargs)

                blocked_helpers = (
                    "_backfill_session_metrics",
                    "_build_ttl_period_summary",
                    "_cache_ttl_waste_cached",
                    "_collect_git_commits",
                    "_collect_posix_claude_sessions",
                    "_collect_quality_for_dashboard",
                    "_dashboard_savings_data",
                    "_get_v5_feature_status",
                    "_get_v5_savings_recommendation",
                    "_load_pricing_tier",
                    "_read_settings_for_write",
                    "_read_settings_json",
                    "_read_settings_json_checked",
                    "find_projects_dir",
                    "generate_auto_recommendations",
                    "generate_coach_data",
                    "keepwarm_billing_mode",
                    "keepwarm_cache_health_block",
                    "runway_snapshot",
                )
                patches = [
                    mock.patch.object(measure, name, blocked)
                    for name in blocked_helpers
                ]
                with contextlib.ExitStack() as stack:
                    for patch in patches:
                        stack.enter_context(patch)
                    stack.enter_context(
                        mock.patch("builtins.open", side_effect=guarded_open)
                    )
                    stack.enter_context(
                        mock.patch.object(Path, "open", guarded_path_open)
                    )
                    output = measure.generate_standalone_dashboard(
                        days=3650,
                        quiet=True,
                        force=True,
                    )

            self.assertEqual(output, str(expected))
            self.assertTrue(expected.is_file())
            self.assertTrue(expected.with_suffix(".meta.json").is_file())
            self.assertFalse(legacy.exists())
            self.assertFalse(legacy.with_suffix(".meta.json").exists())
            marker = "window.__TOKEN_DATA__ = "
            encoded = expected.read_text(encoding="utf-8").split(marker, 1)[1]
            payload, _ = json.JSONDecoder().raw_decode(encoded)
            self.assertEqual(payload["runtime"], "pi")
            self.assertEqual(payload["pricing_tier"], "pi_usage")
            self.assertEqual(payload["pricing_tier_label"], "Exact Pi usage")
            self.assertEqual(payload["pricing_tiers"], {})
            self.assertIsNone(payload["plan"])
            self.assertFalse(payload["auto_plan"])
            self.assertIsNone(payload["coach"])
            self.assertEqual(payload["manage"]["v5_features"], {})
            self.assertEqual(payload["health"]["recommendations"], [])
            self.assertEqual(payload["trends"]["total_cost_usd"], parsed["cost_usd"])
            details = payload["trends"]["daily"][0]["session_details"]
            self.assertEqual(details[0]["cost_source"], "pi_usage")
            blocked.assert_not_called()

    def test_pi_dashboard_collectors_do_not_use_foreign_host_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi"
            snapshot = pi_home / "token-optimizer" / "data"
            snapshot.mkdir(parents=True)
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(snapshot),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                measure = fresh_import("measure")
                blocked = mock.Mock(
                    side_effect=AssertionError("foreign host collector called")
                )
                with (
                    mock.patch.object(measure, "_read_settings_json", blocked),
                    mock.patch.object(measure, "find_projects_dir", blocked),
                    mock.patch.object(
                        measure, "_collect_posix_claude_sessions", blocked
                    ),
                    mock.patch.object(measure, "_collect_git_commits", blocked),
                ):
                    components = measure.measure_components()
                    self.assertEqual(components["pi_runtime"]["runtime"], "pi")
                    self.assertEqual(measure.get_session_baselines(), [])
                    self.assertEqual(
                        measure._collect_hook_status_for_dashboard()["pi_extension"][
                            "managed_by"
                        ],
                        "pi",
                    )
                    self.assertEqual(measure._collect_management_data()["mode"], "pi")
                    self.assertEqual(measure._collect_health_data()["runtime"], "pi")
                    self.assertEqual(
                        measure.detect_context_window(),
                        (None, "Pi context window unavailable"),
                    )
                    self.assertIsNone(measure._collect_trends_data(days=1))
                blocked.assert_not_called()

                self.assertIn("pi", measure._FOREIGN_RUNTIMES)
                self.assertNotIn("pi", measure._FOREIGN_RUNTIME_EXEMPTIONS)

    def test_pi_rollup_then_trends_query_preserves_normalized_cache_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi"
            snapshot = pi_home / "token-optimizer" / "data"
            snapshot.mkdir(parents=True)
            session = root / "session.jsonl"
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", session)
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(snapshot),
                "PI_CODING_AGENT_SESSION_DIR": str(root),
                "PI_SESSION_FILE": str(session),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            session_key = "pi:11111111-1111-4111-8111-111111111111"
            with mock.patch.dict(os.environ, env, clear=True):
                measure = fresh_import("measure")
                parsed = measure.pi_session.parse_session_jsonl(session)
                self.assertIsNotNone(parsed)
                assert parsed is not None
                expected = (
                    parsed["total_cache_create_1h"],
                    parsed["total_cache_create_5m"],
                    parsed["avg_call_gap_seconds"],
                    parsed["max_call_gap_seconds"],
                    parsed["p95_call_gap_seconds"],
                )
                conn = measure._init_trends_db()
                try:
                    self.assertTrue(
                        measure._insert_normalized_session(
                            conn,
                            parsed,
                            session_key=session_key,
                            project_name="pi-project",
                            incomplete=False,
                        )
                    )
                    conn.commit()
                finally:
                    conn.close()

                trends = measure._collect_trends_data(days=1)
                self.assertIsNotNone(trends)
                conn = measure._init_trends_db()
                try:
                    row = conn.execute(
                        "SELECT cache_create_1h_tokens, cache_create_5m_tokens, "
                        "avg_call_gap_seconds, max_call_gap_seconds, "
                        "p95_call_gap_seconds FROM session_log WHERE jsonl_path = ?",
                        (session_key,),
                    ).fetchone()
                finally:
                    conn.close()

            self.assertEqual(row, expected)

    def test_repeated_incomplete_pi_rollups_refresh_before_finalization(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi"
            snapshot = pi_home / "token-optimizer" / "data"
            snapshot.mkdir(parents=True)
            session = root / "session.jsonl"
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", session)
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(snapshot),
                "PI_CODING_AGENT_SESSION_DIR": str(root),
                "PI_SESSION_FILE": str(session),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            session_key = "pi:22222222-2222-4222-8222-222222222222"
            with mock.patch.dict(os.environ, env, clear=True):
                measure = fresh_import("measure")
                parsed = measure.pi_session.parse_session_jsonl(session)
                self.assertIsNotNone(parsed)
                assert parsed is not None
                refreshed = dict(parsed)
                refreshed.update(
                    total_input_tokens=1234,
                    total_output_tokens=234,
                    total_cache_create_1h=34,
                    total_cache_create_5m=45,
                    cache_hit_rate=0.75,
                    duration_minutes=12.5,
                )
                finalized = dict(refreshed)
                finalized.update(
                    total_input_tokens=1500,
                    total_output_tokens=300,
                    duration_minutes=15.0,
                )
                conn = measure._init_trends_db()
                try:
                    self.assertTrue(
                        measure._insert_normalized_session(
                            conn,
                            parsed,
                            session_key=session_key,
                            project_name="pi-project",
                            incomplete=True,
                        )
                    )
                    self.assertTrue(
                        measure._insert_normalized_session(
                            conn,
                            refreshed,
                            session_key=session_key,
                            project_name="pi-project",
                            incomplete=True,
                        )
                    )
                    current = conn.execute(
                        "SELECT input_tokens, output_tokens, cache_create_1h_tokens, "
                        "cache_create_5m_tokens, duration_minutes, incomplete "
                        "FROM session_log WHERE jsonl_path = ?",
                        (session_key,),
                    ).fetchone()
                    self.assertEqual(current, (1234, 234, 34, 45, 12.5, 1))

                    self.assertTrue(
                        measure._insert_normalized_session(
                            conn,
                            finalized,
                            session_key=session_key,
                            project_name="pi-project",
                            incomplete=False,
                        )
                    )
                    complete = conn.execute(
                        "SELECT input_tokens, output_tokens, duration_minutes, incomplete "
                        "FROM session_log WHERE jsonl_path = ?",
                        (session_key,),
                    ).fetchone()
                    self.assertEqual(complete, (1500, 300, 15.0, 0))
                finally:
                    conn.close()

    def test_normalized_pi_rollup_upserts_one_current_session_row(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi"
            snapshot = pi_home / "token-optimizer" / "data"
            snapshot.mkdir(parents=True)
            session = root / "session.jsonl"
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", session)
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(snapshot),
                "PI_CODING_AGENT_SESSION_DIR": str(root),
                "PI_SESSION_FILE": str(session),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                measure = fresh_import("measure")
                parsed = measure.pi_session.parse_session_jsonl(session)
                self.assertIsNotNone(parsed)
                assert parsed is not None
                conn = measure._init_trends_db()
                try:
                    self.assertTrue(
                        measure._insert_normalized_session(
                            conn,
                            parsed,
                            session_key="pi:11111111-1111-4111-8111-111111111111",
                            project_name="pi-project",
                            incomplete=True,
                        )
                    )
                    self.assertTrue(
                        measure._insert_normalized_session(
                            conn,
                            parsed,
                            session_key="pi:11111111-1111-4111-8111-111111111111",
                            project_name="pi-project",
                            incomplete=False,
                        )
                    )
                    row = conn.execute(
                        "SELECT COUNT(*), platform, incomplete, cost_source "
                        "FROM session_log WHERE jsonl_path = ?",
                        ("pi:11111111-1111-4111-8111-111111111111",),
                    ).fetchone()
                    self.assertEqual(row, (1, "pi", 0, "pi_usage"))
                finally:
                    conn.close()


class PiArchiveAndBashTests(unittest.TestCase):
    def test_external_pi_archive_never_reads_claude_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi"
            snapshot = pi_home / "token-optimizer" / "data"
            claude_home = root / ".claude"
            snapshot.mkdir(parents=True)
            claude_home.mkdir()
            settings_path = claude_home / "settings.json"
            settings_path.write_text(
                json.dumps(
                    {
                        "env": {
                            "MAX_MCP_OUTPUT_TOKENS": "1",
                            "TOKEN_OPTIMIZER_ARCHIVE_EXEMPT_DEFAULTS": "off",
                            "TOKEN_OPTIMIZER_ARCHIVE_EXEMPT_TOOLS": "acme.*",
                        }
                    }
                ),
                encoding="utf-8",
            )
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(snapshot),
                "CLAUDE_CONFIG_DIR": str(claude_home),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            payload = {
                "tool_kind": "external",
                "tool_name": "acme.search",
                "tool_use_id": "tool-call-sentinel",
                "tool_input": {"query": "needle"},
                "tool_response": "result line\n" * 20,
                "session_id": "pi-session-sentinel",
            }
            opened = []
            real_open = open

            def tracking_open(path, *args, **kwargs):
                opened.append(Path(path))
                return real_open(path, *args, **kwargs)

            with mock.patch.dict(os.environ, env, clear=True):
                archive_result = fresh_import("archive_result")
                with (
                    mock.patch("builtins.open", side_effect=tracking_open),
                    mock.patch.object(archive_result, "_ARCHIVE_THRESHOLD", 32),
                ):
                    result = archive_result.archive_result(
                        quiet=True, hook_input=payload
                    )
                    self.assertIsNone(archive_result._resolve_mcp_cap_tokens())

            self.assertIsNotNone(result)
            assert result is not None
            self.assertIsNotNone(result["replacement_text"])
            self.assertNotIn(settings_path, opened)

    def test_external_pi_tool_archives_under_its_real_name_and_returns_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi home"
            snapshot = pi_home / "token-optimizer" / "data"
            snapshot.mkdir(parents=True)
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(snapshot),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            secret = "sk-abcdefghijklmnopqrstuvwxyz"
            payload = {
                "tool_kind": "external",
                "tool_name": "acme.search",
                "tool_use_id": "tool-call-1",
                "tool_input": {"query": "needle"},
                "tool_response": secret + "\n" + "result line\n" * 20,
                "session_id": "pi-session-1",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                archive_result = fresh_import("archive_result")
                with mock.patch.object(archive_result, "_ARCHIVE_THRESHOLD", 32):
                    result = archive_result.archive_result(
                        quiet=True,
                        hook_input=payload,
                    )

                self.assertIsNotNone(result)
                assert result is not None
                self.assertEqual(result["archive_id"], "tool-call-1")
                self.assertEqual(result["metadata"]["tool_kind"], "external")
                self.assertEqual(result["metadata"]["tool_name"], "acme.search")
                self.assertIn("Full result archived", result["replacement_text"])
                self.assertNotIn("mcp__", result["replacement_text"])

                entry = snapshot / "tool-archive" / "pi-session-1" / "tool-call-1.json"
                archived = json.loads(entry.read_text(encoding="utf-8"))
                self.assertEqual(archived["tool_kind"], "external")
                self.assertEqual(archived["tool_name"], "acme.search")
                self.assertNotIn(secret, archived["response"])
                self.assertIn("CREDENTIAL REDACTED", archived["response"])

    def test_external_pi_tool_honors_archive_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi"
            snapshot = pi_home / "token-optimizer" / "data"
            snapshot.mkdir(parents=True)
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(snapshot),
                "TOKEN_OPTIMIZER_ARCHIVE_EXEMPT_DEFAULTS": "off",
                "TOKEN_OPTIMIZER_ARCHIVE_EXEMPT_TOOLS": "acme.*",
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            payload = {
                "tool_kind": "external",
                "tool_name": "acme.search",
                "tool_use_id": "tool-call-exempt",
                "tool_input": {"query": "needle"},
                "tool_response": "result line\n" * 20,
                "session_id": "pi-session-exempt",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                archive_result = fresh_import("archive_result")
                with mock.patch.object(archive_result, "_ARCHIVE_THRESHOLD", 32):
                    result = archive_result.archive_result(
                        quiet=True, hook_input=payload
                    )

            self.assertIsNotNone(result)
            assert result is not None
            self.assertEqual(result["archive_id"], "tool-call-exempt")
            self.assertIsNone(result["replacement_text"])
            self.assertTrue(
                (
                    snapshot
                    / "tool-archive"
                    / "pi-session-exempt"
                    / "tool-call-exempt.json"
                ).is_file()
            )

    def test_external_pi_tool_fails_open_when_retention_prunes_new_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi"
            snapshot = pi_home / "token-optimizer" / "data"
            snapshot.mkdir(parents=True)
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(snapshot),
                "TOKEN_OPTIMIZER_ARCHIVE_CLEANUP_INTERVAL_SECONDS": "0",
                "TOKEN_OPTIMIZER_ARCHIVE_RETENTION_MAX_BYTES": "1",
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            payload = {
                "tool_kind": "external",
                "tool_name": "acme.search",
                "tool_use_id": "tool-call-pruned",
                "tool_input": {"query": "needle"},
                "tool_response": "result line\n" * 20,
                "session_id": "pi-session-pruned",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                archive_result = fresh_import("archive_result")
                with mock.patch.object(archive_result, "_ARCHIVE_THRESHOLD", 32):
                    result = archive_result.archive_result(
                        quiet=True, hook_input=payload
                    )

            self.assertIsNone(result)
            self.assertFalse(
                (
                    snapshot
                    / "tool-archive"
                    / "pi-session-pruned"
                    / "tool-call-pruned.json"
                ).exists()
            )

    def test_original_archive_hook_reads_stdin_and_emits_legacy_envelope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "snapshot"
            snapshot.mkdir()
            payload = {
                "tool_name": "mcp__acme__search",
                "tool_use_id": "tool-call-2",
                "tool_input": {"query": "needle"},
                "tool_response": "result line\n" * 20,
                "session_id": "session-2",
            }
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(snapshot),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                archive_result = fresh_import("archive_result")
                output = io.StringIO()
                with (
                    mock.patch.object(
                        archive_result,
                        "read_stdin_hook_input",
                        return_value=payload,
                    ) as read_input,
                    mock.patch.object(archive_result, "_ARCHIVE_THRESHOLD", 32),
                    contextlib.redirect_stdout(output),
                ):
                    result = archive_result.archive_result(quiet=True)

            self.assertIsNone(result)
            read_input.assert_called_once_with(archive_result._STDIN_MAX_BYTES)
            response = json.loads(output.getvalue())
            self.assertEqual(
                response["hookSpecificOutput"]["hookEventName"],
                "PostToolUse",
            )
            self.assertIn(
                "Full result archived",
                response["hookSpecificOutput"]["updatedMCPToolOutput"],
            )

    def test_pi_bash_rewrite_pins_runtime_paths_and_keeps_original_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi home"
            snapshot = pi_home / "token-optimizer" / "data snapshot"
            snapshot.mkdir(parents=True)
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "pi",
                "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR": str(snapshot),
                "PI_SESSION_ID": "pi-session-1",
                "PYTHONPATH": str(root / "existing python"),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            payload = {
                "tool_name": "Bash",
                "tool_input": {"command": "git status"},
                "cwd": str(root),
                "session_id": "pi-session-1",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                bash_hook = fresh_import("bash_hook")
                output = io.StringIO()
                with (
                    mock.patch("hook_io.read_stdin_hook_input", return_value=payload),
                    mock.patch("context_pressure.should_inject", return_value=True),
                    contextlib.redirect_stdout(output),
                ):
                    bash_hook.main()

            response = json.loads(output.getvalue())
            rewritten = response["hookSpecificOutput"]["updatedInput"]["command"]
            package_python = ROOT / "python"
            expected_pythonpath = os.pathsep.join(
                (str(package_python), str(root / "existing python"))
            )
            self.assertIn("export TOKEN_OPTIMIZER_RUNTIME=pi", rewritten)
            self.assertIn(
                "TOKEN_OPTIMIZER_PI_HOME=" + shlex.quote(str(pi_home.resolve())),
                rewritten,
            )
            self.assertIn(
                "TOKEN_OPTIMIZER_SNAPSHOT_DIR=" + shlex.quote(str(snapshot)),
                rewritten,
            )
            self.assertIn("PYTHONPATH=" + shlex.quote(expected_pythonpath), rewritten)
            self.assertIn("PI_SESSION_ID=pi-session-1", rewritten)
            self.assertTrue(rewritten.endswith("; done; git status"))

    def test_pi_bash_rewrite_fails_open_when_snapshot_is_missing_or_unsafe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_home = root / "pi"
            outside_snapshot = root / "outside"
            pi_home.mkdir()
            outside_snapshot.mkdir()
            payload = {
                "tool_name": "Bash",
                "tool_input": {"command": "git status"},
                "cwd": str(root),
                "session_id": "pi-session-1",
            }
            for snapshot in (None, outside_snapshot):
                with self.subTest(snapshot=snapshot):
                    env = {
                        "HOME": str(root),
                        "TOKEN_OPTIMIZER_RUNTIME": "pi",
                        "TOKEN_OPTIMIZER_PI_HOME": str(pi_home),
                        "PI_SESSION_ID": "pi-session-1",
                        "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
                    }
                    if snapshot is not None:
                        env["TOKEN_OPTIMIZER_SNAPSHOT_DIR"] = str(snapshot)
                    with mock.patch.dict(os.environ, env, clear=True):
                        bash_hook = fresh_import("bash_hook")
                        output = io.StringIO()
                        with (
                            mock.patch(
                                "hook_io.read_stdin_hook_input",
                                return_value=payload,
                            ),
                            contextlib.redirect_stdout(output),
                        ):
                            bash_hook.main()

                    self.assertEqual(output.getvalue(), "")

    def test_non_pi_bash_rewrite_keeps_upstream_session_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            claude_home = root / ".claude"
            claude_home.mkdir()
            env = {
                "HOME": str(root),
                "TOKEN_OPTIMIZER_RUNTIME": "claude",
                "CLAUDE_CONFIG_DIR": str(claude_home),
                "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
            }
            payload = {
                "tool_name": "Bash",
                "tool_input": {"command": "git status"},
                "cwd": str(root),
                "session_id": "claude-session-1",
            }
            with mock.patch.dict(os.environ, env, clear=True):
                bash_hook = fresh_import("bash_hook")
                output = io.StringIO()
                with (
                    mock.patch("hook_io.read_stdin_hook_input", return_value=payload),
                    mock.patch("context_pressure.should_inject", return_value=True),
                    contextlib.redirect_stdout(output),
                ):
                    bash_hook.main()

            response = json.loads(output.getvalue())
            rewritten = response["hookSpecificOutput"]["updatedInput"]["command"]
            self.assertIn("export CLAUDE_SESSION_ID=claude-session-1", rewritten)
            self.assertNotIn("TOKEN_OPTIMIZER_RUNTIME=pi", rewritten)
            self.assertTrue(rewritten.endswith("; done; git status"))


if __name__ == "__main__":
    unittest.main()
