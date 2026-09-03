import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock


sys.dont_write_bytecode = True
from python import pi_bridge


ROOT = Path(__file__).parents[2]
BRIDGE = ROOT / "python" / "pi_bridge.py"
FIXTURE = ROOT / "tests" / "fixtures" / "pi-session-linear.jsonl"
SESSION_ID = "11111111-1111-4111-8111-111111111111"


class PiBridgeReportingTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name).resolve()
        self.pi_home = self.root / "pi-home"
        self.data_root = self.pi_home / "token-optimizer" / "data"
        self.data_root.mkdir(parents=True)
        (self.pi_home / "token-optimizer" / "config.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "enabled": True,
                "consent": {
                    "granted": True,
                    "noticeVersion": 1,
                    "grantedAt": "2026-09-03T12:00:00.000Z",
                },
            }),
            encoding="utf-8",
        )
        self.project = self.root / "project"
        self.project.mkdir()
        self.session_file = self.root / "session.jsonl"
        shutil.copyfile(FIXTURE, self.session_file)
        self.environment = {
            "HOME": str(self.root),
            "PATH": os.environ.get("PATH", ""),
            "PYTHONDONTWRITEBYTECODE": "1",
            "TOKEN_OPTIMIZER_PI_HOME": str(self.pi_home),
            "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
        }

    def request(self, action, args=None):
        request = {
            "protocolVersion": 1,
            "action": action,
            "session": {
                "id": SESSION_ID,
                "cwd": str(self.project),
                "file": str(self.session_file),
            },
        }
        if args is not None:
            request["args"] = args
        return request

    def invoke(self, action, args=None):
        completed = subprocess.run(
            [sys.executable, str(BRIDGE)],
            input=json.dumps(self.request(action, args)).encode("utf-8"),
            capture_output=True,
            cwd=self.root,
            env=self.environment,
            check=False,
        )
        self.assertEqual(completed.returncode, 0)
        stdout = completed.stdout.decode("utf-8", "strict")
        self.assertEqual(len(stdout.splitlines()), 1, stdout)
        return json.loads(stdout), completed.stderr.decode("utf-8", "replace")

    def invoke_direct(self, action, modules, args=None):
        output = io.StringIO()
        errors = io.StringIO()
        with (
            mock.patch.dict(os.environ, self.environment, clear=True),
            mock.patch.object(
                pi_bridge,
                "_load_engine",
                side_effect=lambda name: modules[name],
            ),
        ):
            result = pi_bridge.main(
                io.StringIO(json.dumps(self.request(action, args))),
                output,
                errors,
            )
        self.assertEqual(result, 0)
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        return json.loads(output.getvalue()), errors.getvalue()

    def test_rollup_records_exact_current_pi_usage_as_incomplete(self):
        response, stderr = self.invoke("rollup")

        with contextlib.closing(
            sqlite3.connect(self.data_root / "trends.db")
        ) as connection:
            row = connection.execute(
                "SELECT jsonl_path, project, input_tokens, output_tokens, "
                "cache_create_1h_tokens, cache_create_5m_tokens, "
                "model_usage_json, model_usage_breakdown_json, cost_usd, "
                "cost_source, platform, incomplete FROM session_log"
            ).fetchone()

        self.assertEqual(response, {
            "protocolVersion": 1,
            "ok": True,
            "data": {"available": True, "status": "incomplete"},
        })
        self.assertEqual(row, (
            f"pi:{SESSION_ID}",
            "project",
            815,
            30,
            4,
            11,
            '{"gpt-5.6": 195}',
            '{"gpt-5.6": {"fresh_input": 150, "cache_read": 650, "cache_create": 15, "cache_create_1h": 4, "cache_create_5m": 11, "output": 30}}',
            0.016,
            "pi_usage",
            "pi",
            1,
        ))
        self.assertEqual(stderr, "")

    def test_repeated_rollup_refreshes_the_same_incomplete_row(self):
        first, first_stderr = self.invoke("rollup")
        with self.session_file.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({
                "type": "message",
                "id": "00000009",
                "parentId": "00000008",
                "timestamp": "2026-09-03T10:00:09.000Z",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "One more update."}],
                    "provider": "openai-codex",
                    "model": "gpt-5.6",
                    "usage": {
                        "input": 25,
                        "output": 5,
                        "cacheRead": 10,
                        "cacheWrite": 3,
                        "cacheWrite1h": 2,
                        "cost": {"total": 0.0023456},
                    },
                },
            }, separators=(",", ":")) + "\n")

        second, second_stderr = self.invoke("rollup")

        with contextlib.closing(
            sqlite3.connect(self.data_root / "trends.db")
        ) as connection:
            row = connection.execute(
                "SELECT COUNT(*), input_tokens, output_tokens, "
                "cache_create_1h_tokens, cache_create_5m_tokens, cost_usd, "
                "cost_source, incomplete FROM session_log WHERE jsonl_path = ?",
                (f"pi:{SESSION_ID}",),
            ).fetchone()
        self.assertEqual(first["data"]["status"], "incomplete")
        self.assertEqual(second["data"]["status"], "incomplete")
        self.assertEqual(row, (1, 853, 35, 6, 12, 0.018346, "pi_usage", 1))
        self.assertEqual(first_stderr, "")
        self.assertEqual(second_stderr, "")

    def test_finalize_completes_the_same_row_and_writes_one_end_checkpoint(self):
        rollup, rollup_stderr = self.invoke("rollup")
        first, first_stderr = self.invoke("finalize")
        second, second_stderr = self.invoke("finalize")

        with contextlib.closing(
            sqlite3.connect(self.data_root / "trends.db")
        ) as connection:
            row = connection.execute(
                "SELECT COUNT(*), input_tokens, output_tokens, cost_usd, "
                "cost_source, incomplete FROM session_log WHERE jsonl_path = ?",
                (f"pi:{SESSION_ID}",),
            ).fetchone()
        checkpoint_root = self.pi_home / "token-optimizer" / "checkpoints"
        markdown = list(checkpoint_root.glob(f"{SESSION_ID}-*-end.md"))
        sidecars = list(checkpoint_root.glob(f"{SESSION_ID}-*-end.json"))

        self.assertEqual(rollup["data"]["status"], "incomplete")
        self.assertEqual(first, {
            "protocolVersion": 1,
            "ok": True,
            "data": {"available": True, "status": "complete"},
        })
        self.assertEqual(second, first)
        self.assertEqual(row, (1, 815, 30, 0.016, "pi_usage", 0))
        self.assertEqual(len(markdown), 1)
        self.assertEqual(len(sidecars), 1)
        self.assertIn("Trigger: end", markdown[0].read_text(encoding="utf-8"))
        self.assertEqual(rollup_stderr, "")
        self.assertEqual(first_stderr, "")
        self.assertEqual(second_stderr, "")

    def test_reporting_uses_only_the_authorized_file_and_normalized_upsert_seams(self):
        parsed = {
            "slug": SESSION_ID,
            "provider": "exact-provider",
            "model": "exact-model",
            "cost_usd": 1.234567,
            "cost_source": "pi_usage",
            "token_source": "pi_usage",
            "total_cache_read": 91,
            "model_usage": {"exact-model": 123},
        }
        parser = mock.Mock(return_value=parsed)
        connection = mock.Mock()
        upsert = mock.Mock(return_value=True)
        forbidden = mock.Mock(side_effect=AssertionError("session discovery called"))
        adapter = types.SimpleNamespace(
            parse_session_jsonl=parser,
            find_current_session_jsonl=forbidden,
            find_session_jsonl_by_id=forbidden,
            find_all_jsonl_files=forbidden,
        )
        measure = types.SimpleNamespace(
            pi_session=adapter,
            _init_trends_db=mock.Mock(return_value=connection),
            _insert_normalized_session=upsert,
        )

        response, stderr = self.invoke_direct("rollup", {"measure": measure})

        self.assertEqual(response["data"], {
            "available": True,
            "status": "incomplete",
        })
        parser.assert_called_once_with(str(self.session_file))
        upsert.assert_called_once_with(
            connection,
            parsed,
            session_key=f"pi:{SESSION_ID}",
            project_name="project",
            incomplete=True,
        )
        connection.commit.assert_called_once_with()
        connection.close.assert_called_once_with()
        forbidden.assert_not_called()
        self.assertEqual(stderr, "")

    def test_finalize_calls_the_bounded_current_session_checkpoint_once(self):
        parsed = {"slug": SESSION_ID}
        parser = mock.Mock(return_value=parsed)
        events = []
        connection = mock.Mock()
        connection.commit.side_effect = lambda: events.append("commit")

        def checkpoint(**_kwargs):
            events.append("checkpoint")
            return str(self.root / "checkpoint.md")

        measure = types.SimpleNamespace(
            pi_session=types.SimpleNamespace(parse_session_jsonl=parser),
            _init_trends_db=mock.Mock(return_value=connection),
            _insert_normalized_session=mock.Mock(side_effect=(True, False)),
            compact_capture=mock.Mock(side_effect=checkpoint),
        )

        first, first_stderr = self.invoke_direct("finalize", {"measure": measure})
        second, second_stderr = self.invoke_direct("finalize", {"measure": measure})

        self.assertEqual(first["data"]["status"], "complete")
        self.assertEqual(second["data"]["status"], "complete")
        self.assertEqual(parser.call_count, 2)
        self.assertEqual(measure._insert_normalized_session.call_count, 2)
        measure.compact_capture.assert_called_once_with(
            transcript_path=str(self.session_file),
            session_id=SESSION_ID,
            trigger="end",
            cwd=str(self.project),
        )
        self.assertEqual(connection.commit.call_count, 2)
        self.assertEqual(connection.close.call_count, 2)
        self.assertEqual(events, ["commit", "checkpoint", "commit"])
        self.assertEqual(first_stderr, "")
        self.assertEqual(second_stderr, "")

    def test_finalize_commit_failure_does_not_write_a_checkpoint(self):
        parsed = {"slug": SESSION_ID}
        connection = mock.Mock()
        connection.commit.side_effect = sqlite3.OperationalError("commit failed")
        checkpoint = mock.Mock(return_value=str(self.root / "checkpoint.md"))
        measure = types.SimpleNamespace(
            pi_session=types.SimpleNamespace(
                parse_session_jsonl=mock.Mock(return_value=parsed),
            ),
            _init_trends_db=mock.Mock(return_value=connection),
            _insert_normalized_session=mock.Mock(return_value=True),
            compact_capture=checkpoint,
        )

        response, stderr = self.invoke_direct("finalize", {"measure": measure})

        self.assertEqual(response["data"], {
            "available": False,
            "status": "unavailable",
        })
        checkpoint.assert_not_called()
        connection.rollback.assert_called_once_with()
        connection.close.assert_called_once_with()
        self.assertIn("report failure (OperationalError)", stderr)

    def test_checkpoint_failure_keeps_committed_finalize_idempotent_on_retry(self):
        parsed = {"slug": SESSION_ID}
        connection = mock.Mock()
        checkpoint = mock.Mock(side_effect=RuntimeError("checkpoint failed"))
        measure = types.SimpleNamespace(
            pi_session=types.SimpleNamespace(
                parse_session_jsonl=mock.Mock(return_value=parsed),
            ),
            _init_trends_db=mock.Mock(return_value=connection),
            _insert_normalized_session=mock.Mock(side_effect=(True, False)),
            compact_capture=checkpoint,
        )

        first, first_stderr = self.invoke_direct("finalize", {"measure": measure})
        second, second_stderr = self.invoke_direct("finalize", {"measure": measure})

        self.assertEqual(first["data"], {
            "available": False,
            "status": "unavailable",
        })
        self.assertEqual(second["data"], {
            "available": True,
            "status": "complete",
        })
        self.assertEqual(connection.commit.call_count, 2)
        self.assertEqual(connection.close.call_count, 2)
        connection.rollback.assert_not_called()
        checkpoint.assert_called_once_with(
            transcript_path=str(self.session_file),
            session_id=SESSION_ID,
            trigger="end",
            cwd=str(self.project),
        )
        self.assertIn("report failure (RuntimeError)", first_stderr)
        self.assertEqual(second_stderr, "")

    def test_reporting_deadline_restores_the_previous_signal_and_timer(self):
        original_handler = signal.getsignal(signal.SIGALRM)
        original_timer = signal.getitimer(signal.ITIMER_REAL)
        connection = mock.Mock()
        measure = types.SimpleNamespace(
            pi_session=types.SimpleNamespace(
                parse_session_jsonl=mock.Mock(return_value={"slug": SESSION_ID}),
            ),
            _init_trends_db=mock.Mock(return_value=connection),
            _insert_normalized_session=mock.Mock(return_value=True),
        )

        def previous_handler(_signum, _frame):
            return None

        try:
            signal.signal(signal.SIGALRM, previous_handler)
            signal.setitimer(signal.ITIMER_REAL, 5, 1)
            response, stderr = self.invoke_direct("rollup", {"measure": measure})
            delay, interval = signal.getitimer(signal.ITIMER_REAL)
            self.assertEqual(response["data"]["status"], "incomplete")
            self.assertEqual(stderr, "")
            self.assertIs(signal.getsignal(signal.SIGALRM), previous_handler)
            self.assertGreater(delay, 4)
            self.assertLessEqual(delay, 5)
            self.assertEqual(interval, 1)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, original_handler)
            signal.setitimer(signal.ITIMER_REAL, *original_timer)

    def test_unavailable_sessions_and_sqlite_contention_fail_open_once(self):
        self.session_file.unlink()
        missing, missing_stderr = self.invoke_direct("rollup", {})
        self.assertEqual(missing, {
            "protocolVersion": 1,
            "ok": True,
            "data": {"available": False, "status": "unavailable"},
        })
        self.assertIn("missing or unauthorized session", missing_stderr)

        shutil.copyfile(FIXTURE, self.session_file)
        raw = self.session_file.read_text(encoding="utf-8")
        self.session_file.write_text(
            raw.replace(SESSION_ID, "22222222-2222-4222-8222-222222222222", 1),
            encoding="utf-8",
        )
        unauthorized, unauthorized_stderr = self.invoke_direct("finalize", {})
        self.assertEqual(unauthorized["data"], {
            "available": False,
            "status": "unavailable",
        })
        self.assertIn("missing or unauthorized session", unauthorized_stderr)

        shutil.copyfile(FIXTURE, self.session_file)
        parsed = {"slug": SESSION_ID}
        parser = mock.Mock(return_value=parsed)
        measure = types.SimpleNamespace(
            pi_session=types.SimpleNamespace(parse_session_jsonl=parser),
            _init_trends_db=mock.Mock(
                side_effect=sqlite3.OperationalError("database is locked")
            ),
        )
        contended, contended_stderr = self.invoke_direct(
            "rollup",
            {"measure": measure},
        )
        self.assertEqual(contended["data"], {
            "available": False,
            "status": "unavailable",
        })
        parser.assert_called_once_with(str(self.session_file))
        self.assertIn("report failure (OperationalError)", contended_stderr)
        self.assertNotIn("Traceback", contended_stderr)

    def test_real_sqlite_contention_preserves_the_existing_rollup(self):
        first, first_stderr = self.invoke("rollup")
        database = self.data_root / "trends.db"
        connection = sqlite3.connect(database)
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "UPDATE session_log SET input_tokens = input_tokens "
                "WHERE jsonl_path = ?",
                (f"pi:{SESSION_ID}",),
            )
            started = time.monotonic()
            response, stderr = self.invoke("rollup")
            elapsed = time.monotonic() - started
            row = connection.execute(
                "SELECT COUNT(*), input_tokens, incomplete FROM session_log "
                "WHERE jsonl_path = ?",
                (f"pi:{SESSION_ID}",),
            ).fetchone()
        finally:
            connection.rollback()
            connection.close()

        self.assertEqual(first["data"]["status"], "incomplete")
        self.assertEqual(response["data"], {
            "available": False,
            "status": "unavailable",
        })
        self.assertLess(elapsed, 1.5)
        self.assertEqual(row, (1, 815, 1))
        self.assertEqual(first_stderr, "")
        self.assertNotIn("Traceback", stderr)

    def test_malformed_session_fails_open_without_creating_a_trends_row(self):
        self.session_file.write_text(
            json.dumps({
                "type": "session",
                "version": 3,
                "id": SESSION_ID,
                "cwd": str(self.project),
            }) + "\n{malformed\n",
            encoding="utf-8",
        )

        response, stderr = self.invoke("rollup")

        self.assertEqual(response["data"], {
            "available": False,
            "status": "unavailable",
        })
        self.assertFalse((self.data_root / "trends.db").exists())
        self.assertIn("report failure (ValueError)", stderr)
        self.assertNotIn("Traceback", stderr)

    def test_rollup_after_finalize_does_not_downgrade_or_duplicate_checkpoint(self):
        first, first_stderr = self.invoke("finalize")
        settled, settled_stderr = self.invoke("rollup")

        with contextlib.closing(
            sqlite3.connect(self.data_root / "trends.db")
        ) as connection:
            row = connection.execute(
                "SELECT COUNT(*), incomplete FROM session_log WHERE jsonl_path = ?",
                (f"pi:{SESSION_ID}",),
            ).fetchone()
        checkpoints = list(
            (self.pi_home / "token-optimizer" / "checkpoints").glob(
                f"{SESSION_ID}-*-end.md"
            )
        )
        self.assertEqual(first["data"]["status"], "complete")
        self.assertEqual(settled["data"]["status"], "complete")
        self.assertEqual(row, (1, 0))
        self.assertEqual(len(checkpoints), 1)
        self.assertEqual(first_stderr, "")
        self.assertEqual(settled_stderr, "")

    def test_dashboard_invokes_only_the_static_pi_generator_at_the_exact_path(self):
        expected = self.pi_home / "token-optimizer" / "dashboard.html"

        def generate(**kwargs):
            expected.write_text("<html>Pi trends</html>", encoding="utf-8")
            return str(expected)

        generator = mock.Mock(side_effect=generate)
        measure = types.SimpleNamespace(generate_standalone_dashboard=generator)

        response, stderr = self.invoke_direct("dashboard", {"measure": measure})

        self.assertEqual(response, {
            "protocolVersion": 1,
            "ok": True,
            "data": {
                "available": True,
                "status": "ready",
                "path": str(expected),
            },
        })
        generator.assert_called_once_with(days=30, quiet=True, force=True)
        self.assertEqual(stderr, "")

    def test_dashboard_failure_and_wrong_destination_are_unavailable(self):
        outside = self.root / "outside.html"
        outside.write_text("foreign", encoding="utf-8")
        cases = (
            mock.Mock(return_value=str(outside)),
            mock.Mock(side_effect=RuntimeError("generation failed")),
        )
        for generator in cases:
            with self.subTest(generator=generator.side_effect):
                measure = types.SimpleNamespace(
                    generate_standalone_dashboard=generator,
                )
                response, stderr = self.invoke_direct(
                    "dashboard",
                    {"measure": measure},
                )

                self.assertEqual(response, {
                    "protocolVersion": 1,
                    "ok": True,
                    "data": {"available": False, "status": "unavailable"},
                })
                self.assertNotIn(str(outside), json.dumps(response))
                self.assertIn("dashboard failure", stderr)

    def test_dashboard_rejects_unsafe_output_before_invoking_generator(self):
        expected = self.pi_home / "token-optimizer" / "dashboard.html"
        outside = self.root / "outside.html"
        outside.write_text("foreign", encoding="utf-8")
        expected.symlink_to(outside)
        generator = mock.Mock(side_effect=AssertionError("generator called"))
        measure = types.SimpleNamespace(generate_standalone_dashboard=generator)

        response, stderr = self.invoke_direct("dashboard", {"measure": measure})

        self.assertEqual(response["data"], {
            "available": False,
            "status": "unavailable",
        })
        generator.assert_not_called()
        self.assertEqual(outside.read_text(encoding="utf-8"), "foreign")
        self.assertIn("dashboard failure", stderr)

    def test_real_dashboard_action_writes_only_the_pi_static_destination(self):
        response, stderr = self.invoke("dashboard")
        expected = self.pi_home / "token-optimizer" / "dashboard.html"

        self.assertEqual(response["data"], {
            "available": True,
            "status": "ready",
            "path": str(expected),
        })
        self.assertTrue(expected.is_file())
        self.assertFalse(
            (self.pi_home / "_backups" / "token-optimizer" / "dashboard.html").exists()
        )
        self.assertEqual(stderr, "")

    def test_expand_returns_a_bounded_current_session_line_slice(self):
        archive_id = "saved-1"
        lines = [f"line {number}" for number in range(2_200)]
        archive = self.data_root / "tool-archive" / SESSION_ID
        archive.mkdir(parents=True)
        (archive / f"{archive_id}.json").write_text(json.dumps({
            "tool_name": "acme.search",
            "tool_kind": "external",
            "tool_use_id": archive_id,
            "archived_from": "PostToolUse",
            "response": "\n".join(lines),
        }), encoding="utf-8")

        response, stderr = self.invoke(
            "expand",
            {"archiveId": archive_id, "offset": 100, "limit": 2_000},
        )

        self.assertEqual(response, {
            "protocolVersion": 1,
            "ok": True,
            "data": {
                "archiveId": archive_id,
                "sessionId": SESSION_ID,
                "offset": 100,
                "text": "\n".join(lines[100:2_100]),
                "nextOffset": 2_100,
            },
        })
        self.assertLessEqual(
            len(response["data"]["text"].encode("utf-8")),
            50 * 1024,
        )
        self.assertLessEqual(len(response["data"]["text"].splitlines()), 2_000)
        self.assertEqual(stderr, "")

    def test_expand_keeps_multibyte_slices_inside_protocol_response_limits(self):
        archive_id = "unicode-1"
        archive = self.data_root / "tool-archive" / SESSION_ID
        archive.mkdir(parents=True)
        (archive / f"{archive_id}.json").write_text(json.dumps({
            "tool_name": "acme.search",
            "tool_kind": "external",
            "tool_use_id": archive_id,
            "archived_from": "PostToolUse",
            "response": "\n".join(["é" * 100] * 1_000),
        }), encoding="utf-8")

        response, _stderr = self.invoke(
            "expand",
            {"archiveId": archive_id, "offset": 0, "limit": 2_000},
        )

        self.assertTrue(response["ok"])
        text = response["data"]["text"]
        self.assertLessEqual(len(text.encode("utf-8")), 50 * 1024)
        self.assertLessEqual(len(text.splitlines()), 2_000)
        self.assertGreaterEqual(response["data"]["nextOffset"], 0)
        self.assertLessEqual(
            len(json.dumps(response, ensure_ascii=True).encode("utf-8")),
            pi_bridge.MAX_RESPONSE_BYTES,
        )

    def test_expand_pages_one_oversized_unicode_line_without_loss(self):
        archive_id = "oversized-unicode-1"
        original = "start-" + ("é漢🙂\\\"\x7f" * 6_000) + "-end"
        archive = self.data_root / "tool-archive" / SESSION_ID
        archive.mkdir(parents=True)
        (archive / f"{archive_id}.json").write_text(json.dumps({
            "tool_name": "acme.search",
            "tool_kind": "external",
            "tool_use_id": archive_id,
            "archived_from": "PostToolUse",
            "response": original,
        }), encoding="utf-8")

        chunks = []
        offsets = []
        offset = 0
        while True:
            response, _stderr = self.invoke(
                "expand",
                {"archiveId": archive_id, "offset": offset, "limit": 1},
            )
            data = response["data"]
            offsets.append(data["offset"])
            chunks.append(data["text"])
            self.assertLessEqual(
                len(data["text"].encode("utf-8")),
                pi_bridge.MAX_EXPANSION_TEXT_BYTES,
            )
            if "nextOffset" not in data:
                break
            self.assertGreater(data["nextOffset"], offset)
            offset = data["nextOffset"]

        repeated, _stderr = self.invoke(
            "expand",
            {"archiveId": archive_id, "offset": 0, "limit": 1},
        )
        self.assertEqual(repeated["data"]["text"], chunks[0])
        self.assertEqual(repeated["data"]["nextOffset"], 1)
        self.assertEqual(offsets, list(range(len(chunks))))
        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(chunks), original)

    def test_expand_accepts_the_pi_bash_archive_metadata(self):
        archive_id = "bash-archive-1"
        archive = self.data_root / "tool-archive" / SESSION_ID
        archive.mkdir(parents=True)
        (archive / f"{archive_id}.json").write_text(json.dumps({
            "tool_name": "Bash",
            "tool_use_id": archive_id,
            "archived_from": "compress_with_preservation",
            "response": "saved bash output",
        }), encoding="utf-8")

        response, stderr = self.invoke("expand", {"archiveId": archive_id})

        self.assertEqual(response["data"]["text"], "saved bash output")
        self.assertEqual(response["data"]["sessionId"], SESSION_ID)
        self.assertEqual(stderr, "")

    def test_expand_uses_current_session_first_and_rejects_cross_session_ambiguity(self):
        archive_id = "shared-1"

        def write_entry(session_id, text):
            directory = self.data_root / "tool-archive" / session_id
            directory.mkdir(parents=True, exist_ok=True)
            (directory / f"{archive_id}.json").write_text(json.dumps({
                "tool_name": "acme.search",
                "tool_kind": "external",
                "tool_use_id": archive_id,
                "session_id": session_id,
                "archived_from": "PostToolUse",
                "response": text,
            }), encoding="utf-8")

        write_entry("other-1", "older result")
        found, _stderr = self.invoke("expand", {"archiveId": archive_id})
        self.assertEqual(found["data"]["sessionId"], "other-1")
        self.assertEqual(found["data"]["text"], "older result")

        write_entry("other-2", "ambiguous result")
        ambiguous, ambiguous_stderr = self.invoke(
            "expand",
            {"archiveId": archive_id},
        )
        self.assertEqual(ambiguous, {
            "protocolVersion": 1,
            "ok": False,
            "errorCode": "archive_unavailable",
        })
        self.assertIn("archive unavailable", ambiguous_stderr)

        write_entry(SESSION_ID, "current result")
        current, _stderr = self.invoke("expand", {"archiveId": archive_id})
        self.assertEqual(current["data"]["sessionId"], SESSION_ID)
        self.assertEqual(current["data"]["text"], "current result")

    def test_expand_rejects_missing_malformed_nonregular_and_symlink_entries(self):
        archive_id = "unsafe-1"
        archive = self.data_root / "tool-archive" / SESSION_ID
        archive.mkdir(parents=True)
        entry = archive / f"{archive_id}.json"
        outside = self.root / "outside.json"
        outside.write_text(json.dumps({
            "tool_name": "acme.search",
            "tool_kind": "external",
            "tool_use_id": archive_id,
            "session_id": SESSION_ID,
            "archived_from": "PostToolUse",
            "response": "outside secret",
        }), encoding="utf-8")

        cases = (
            None,
            "{malformed",
            json.dumps({
                "tool_name": "acme.search",
                "tool_kind": "external",
                "tool_use_id": "wrong-id",
                "session_id": SESSION_ID,
                "archived_from": "PostToolUse",
                "response": "wrong id",
            }),
            json.dumps({
                "tool_name": "acme.search",
                "tool_kind": "external",
                "tool_use_id": archive_id,
                "session_id": "wrong-session",
                "archived_from": "PostToolUse",
                "response": "wrong session",
            }),
            "directory",
            "symlink",
        )
        for value in cases:
            with self.subTest(value=value):
                if entry.is_symlink() or entry.is_file():
                    entry.unlink()
                elif entry.is_dir():
                    entry.rmdir()
                if value == "directory":
                    entry.mkdir()
                elif value == "symlink":
                    entry.symlink_to(outside)
                elif value is not None:
                    entry.write_text(value, encoding="utf-8")

                response, stderr = self.invoke(
                    "expand",
                    {"archiveId": archive_id},
                )

                self.assertEqual(response["errorCode"], "archive_unavailable")
                self.assertNotIn(str(outside), json.dumps(response))
                self.assertNotIn(str(outside), stderr)
                self.assertNotIn("outside secret", json.dumps(response))

    def test_expand_redacts_reopened_content_and_uses_only_the_debit_seam(self):
        archive_id = "redact-1"
        secret = "sk-" + "a" * 24
        archive = self.data_root / "tool-archive" / SESSION_ID
        archive.mkdir(parents=True)
        (archive / f"{archive_id}.json").write_text(json.dumps({
            "tool_name": "acme.search",
            "tool_kind": "external",
            "tool_use_id": archive_id,
            "session_id": SESSION_ID,
            "archived_from": "PostToolUse",
            "response": "credential=" + secret,
        }), encoding="utf-8")
        redactor = mock.Mock(return_value="credential=[CREDENTIAL REDACTED]")
        debit = mock.Mock(return_value=None)
        modules = {
            "archive_result": types.SimpleNamespace(_redact_credentials=redactor),
            "measure": types.SimpleNamespace(_log_reexpand_debit=debit),
        }

        response, stderr = self.invoke_direct(
            "expand",
            modules,
            {"archiveId": archive_id},
        )

        self.assertEqual(response["data"]["text"], "credential=[CREDENTIAL REDACTED]")
        self.assertNotIn(secret, json.dumps(response))
        redactor.assert_called_once_with("credential=" + secret)
        debit.assert_called_once_with(
            SESSION_ID,
            archive_id,
            "credential=[CREDENTIAL REDACTED]",
        )
        self.assertEqual(stderr, "")

    def test_reporting_imports_leave_packaged_paths_without_bytecode(self):
        self.invoke("rollup")
        self.invoke("finalize")

        artifacts = [
            path
            for root in (ROOT / "python", ROOT / "vendor" / "token-optimizer")
            for path in root.rglob("*")
            if path.name == "__pycache__" or path.suffix in {".pyc", ".pyo"}
        ]
        self.assertEqual(artifacts, [])


if __name__ == "__main__":
    unittest.main()
