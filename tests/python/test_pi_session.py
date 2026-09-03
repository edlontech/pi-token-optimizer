import json
import math
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest
from unittest import mock

from python import pi_session


FIXTURES = Path(__file__).parents[1] / "fixtures"


class AuthorizedSessionTestCase(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.session_root = Path(self.temporary_directory.name) / "sessions"
        self.session_root.mkdir()
        environment = mock.patch.dict(
            os.environ,
            {"PI_CODING_AGENT_SESSION_DIR": str(self.session_root)},
            clear=True,
        )
        environment.start()
        self.addCleanup(environment.stop)

    def fixture(self, name):
        path = self.session_root / name
        shutil.copyfile(FIXTURES / name, path)
        return path

    def write_session(self, name, records):
        path = self.session_root / name
        path.write_text(
            "".join(json.dumps(record) + "\n" for record in records),
            encoding="utf-8",
        )
        return path


def message_entry(entry_id, parent_id, message):
    return {
        "type": "message",
        "id": entry_id,
        "parentId": parent_id,
        "timestamp": "2026-09-03T12:00:00.000Z",
        "message": message,
    }


def assistant_message(call_id, tool_name, path, text="assistant decision because it matters"):
    return {
        "role": "assistant",
        "content": [
            {"type": "text", "text": text},
            {
                "type": "toolCall",
                "id": call_id,
                "name": tool_name,
                "arguments": {"path": path},
            },
        ],
        "model": "context-model",
    }


def tool_result(call_id, tool_name, output):
    return {
        "role": "toolResult",
        "toolCallId": call_id,
        "toolName": tool_name,
        "content": [{"type": "text", "text": output}],
        "isError": False,
    }


class SessionPathTests(unittest.TestCase):
    def test_current_session_uses_only_pi_session_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            session_dir = root / "sessions"
            session_dir.mkdir()
            current = session_dir / "current.jsonl"
            other = session_dir / "other.jsonl"
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", current)
            shutil.copyfile(FIXTURES / "pi-session-branched.jsonl", other)

            env = {"PI_CODING_AGENT_DIR": str(root)}
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertIsNone(pi_session.find_current_session_jsonl())

                os.environ["PI_SESSION_FILE"] = str(root / "missing.jsonl")
                self.assertIsNone(pi_session.find_current_session_jsonl())

                invalid = root / "invalid.jsonl"
                invalid.write_text('{"type":"session_meta"}\n', encoding="utf-8")
                os.environ["PI_SESSION_FILE"] = str(invalid)
                self.assertIsNone(pi_session.find_current_session_jsonl())

                os.environ["PI_SESSION_FILE"] = str(current)
                self.assertEqual(pi_session.find_current_session_jsonl(), current)
                self.assertTrue(pi_session.is_pi_session_path(current))

    def test_historical_lookup_scans_only_configured_pi_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pi_sessions = root / "pi-sessions"
            foreign_sessions = root / ".codex" / "sessions"
            pi_sessions.mkdir()
            foreign_sessions.mkdir(parents=True)
            older = pi_sessions / "older.jsonl"
            newer = pi_sessions / "newer.jsonl"
            foreign = foreign_sessions / "foreign.jsonl"
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", older)
            shutil.copyfile(FIXTURES / "pi-session-branched.jsonl", newer)
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", foreign)
            now = time.time()
            os.utime(older, (now - 10, now - 10))
            os.utime(newer, (now, now))

            env = {"PI_CODING_AGENT_SESSION_DIR": str(pi_sessions)}
            with mock.patch.dict(os.environ, env, clear=True):
                files = pi_session.find_all_jsonl_files(days=1)
                self.assertEqual([item[0] for item in files], [newer, older])
                self.assertEqual(files[0][2], "pi-project")
                self.assertEqual(
                    pi_session.find_session_jsonl_by_id(
                        "11111111-1111-4111-8111-111111111111"
                    ),
                    older,
                )
                self.assertTrue(pi_session.is_pi_session_path(older))
                self.assertFalse(pi_session.is_pi_session_path(foreign))

            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(pi_session.find_all_jsonl_files(), [])
                self.assertIsNone(
                    pi_session.find_session_jsonl_by_id(
                        "11111111-1111-4111-8111-111111111111"
                    )
                )

    def test_lookup_rejects_traversal_and_symlinks_outside_the_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sessions = root / "sessions"
            sessions.mkdir()
            outside = root / "outside.jsonl"
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", outside)
            linked = sessions / "linked.jsonl"
            linked.symlink_to(outside)

            with mock.patch.dict(
                os.environ,
                {"PI_CODING_AGENT_SESSION_DIR": str(sessions)},
                clear=True,
            ):
                self.assertIsNone(pi_session.find_session_jsonl_by_id("../../outside"))
                self.assertEqual(pi_session.find_all_jsonl_files(), [])
                self.assertFalse(pi_session.is_pi_session_path(linked))

    def test_direct_parsers_require_current_file_or_configured_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sessions = root / "sessions"
            sessions.mkdir()
            authorized = sessions / "authorized.jsonl"
            outside = root / "outside.jsonl"
            linked = sessions / "linked.jsonl"
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", authorized)
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", outside)
            linked.symlink_to(authorized)

            parsers = (
                (pi_session.active_entries, []),
                (pi_session.parse_session_jsonl, None),
                (pi_session.parse_session_turns, []),
                (pi_session.parse_jsonl_for_quality, None),
                (pi_session.extract_session_state, None),
                (pi_session.iter_tool_outputs, []),
            )
            with mock.patch.dict(
                os.environ,
                {"PI_CODING_AGENT_SESSION_DIR": str(sessions)},
                clear=True,
            ):
                for parser, rejected in parsers:
                    with self.subTest(parser=parser.__name__, path="outside"):
                        self.assertEqual(parser(outside), rejected)
                    with self.subTest(parser=parser.__name__, path="symlink"):
                        self.assertEqual(parser(linked), rejected)

            with mock.patch.dict(
                os.environ,
                {"PI_SESSION_FILE": str(outside)},
                clear=True,
            ):
                self.assertIsNotNone(pi_session.parse_session_jsonl(outside))

    def test_historical_lookup_requires_an_exact_unambiguous_header_id(self):
        with tempfile.TemporaryDirectory() as directory:
            sessions = Path(directory) / "sessions"
            sessions.mkdir()
            first = sessions / "first.jsonl"
            duplicate = sessions / "duplicate.jsonl"
            misleading = sessions / "11111111-1111-4111-8111-111111111111.jsonl"
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", first)
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", duplicate)
            shutil.copyfile(FIXTURES / "pi-session-branched.jsonl", misleading)

            with mock.patch.dict(
                os.environ,
                {"PI_CODING_AGENT_SESSION_DIR": str(sessions)},
                clear=True,
            ):
                self.assertIsNone(
                    pi_session.find_session_jsonl_by_id(
                        "11111111-1111-4111-8111-111111111111"
                    )
                )
                self.assertIsNone(pi_session.find_session_jsonl_by_id("11111111"))

            duplicate.unlink()
            with mock.patch.dict(
                os.environ,
                {"PI_CODING_AGENT_SESSION_DIR": str(sessions)},
                clear=True,
            ):
                self.assertEqual(
                    pi_session.find_session_jsonl_by_id(
                        "11111111-1111-4111-8111-111111111111"
                    ),
                    first,
                )

    def test_discovery_filters_before_retaining_the_newest_valid_files(self):
        with tempfile.TemporaryDirectory() as directory:
            sessions = Path(directory) / "sessions"
            sessions.mkdir()
            old = sessions / "00-old.jsonl"
            invalid = sessions / "01-invalid.jsonl"
            middle = sessions / "02-middle.jsonl"
            newest = sessions / "03-newest.jsonl"
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", old)
            invalid.write_text('{"type":"not-a-session"}\n', encoding="utf-8")
            shutil.copyfile(FIXTURES / "pi-session-branched.jsonl", middle)
            shutil.copyfile(FIXTURES / "pi-session-compacted.jsonl", newest)
            now = time.time()
            for age, path in enumerate((newest, middle, invalid, old)):
                os.utime(path, (now - age, now - age))

            with mock.patch.dict(
                os.environ,
                {"PI_CODING_AGENT_SESSION_DIR": str(sessions)},
                clear=True,
            ):
                files = pi_session.find_all_jsonl_files(days=1, max_files=2)

            self.assertEqual([item[0] for item in files], [newest, middle])

    def test_discovery_filters_broken_branches_before_the_newest_heap(self):
        with tempfile.TemporaryDirectory() as directory:
            sessions = Path(directory) / "sessions"
            sessions.mkdir()
            older = sessions / "older-valid.jsonl"
            newer = sessions / "newer-broken.jsonl"
            shutil.copyfile(FIXTURES / "pi-session-linear.jsonl", older)
            newer.write_text(
                '{"type":"session","version":3,"id":"broken-session"}\n'
                '{"type":"message","id":"broken01","parentId":"missing",'
                '"message":{"role":"user","content":"broken"}}\n',
                encoding="utf-8",
            )
            now = time.time()
            os.utime(older, (now - 1, now - 1))
            os.utime(newer, (now, now))

            with mock.patch.dict(
                os.environ,
                {"PI_CODING_AGENT_SESSION_DIR": str(sessions)},
                clear=True,
            ):
                files = pi_session.find_all_jsonl_files(days=1, max_files=1)

            self.assertEqual([item[0] for item in files], [older])


class ActiveBranchTests(AuthorizedSessionTestCase):
    def test_reconstructs_last_branch_and_excludes_abandoned_entries(self):
        entries = pi_session.active_entries(self.fixture("pi-session-branched.jsonl"))

        self.assertEqual(
            [entry["id"] for entry in entries],
            ["a1111111", "b2222222", "e5555555", "f6666666", "07777777"],
        )

    def test_fails_closed_for_broken_parent_chains_and_cycles(self):
        self.assertEqual(
            pi_session.active_entries(self.fixture("pi-session-malformed.jsonl")),
            [],
        )

        records = [
            {"type": "session", "version": 3, "id": "cycle-session"},
            {"type": "message", "id": "cycle001", "parentId": "cycle002"},
            {"type": "message", "id": "cycle002", "parentId": "cycle001"},
        ]
        path = self.write_session("cycle.jsonl", records)
        self.assertEqual(pi_session.active_entries(path), [])

    def test_duplicate_entry_ids_fail_closed(self):
        records = [
            {"type": "session", "version": 3, "id": "duplicate-session"},
            {
                "type": "message",
                "id": "duplicate",
                "parentId": None,
                "message": {"role": "user", "content": "first"},
            },
            {
                "type": "message",
                "id": "duplicate",
                "parentId": "duplicate",
                "message": {"role": "assistant", "content": []},
            },
        ]
        path = self.write_session("duplicate.jsonl", records)

        self.assertEqual(pi_session.active_entries(path), [])
        self.assertIsNone(pi_session.parse_session_jsonl(path))
        self.assertEqual(pi_session.parse_session_turns(path), [])
        self.assertIsNone(pi_session.parse_jsonl_for_quality(path))
        self.assertIsNone(pi_session.extract_session_state(path))
        self.assertEqual(pi_session.iter_tool_outputs(path), [])

    def test_oversized_file_and_line_fail_closed_without_large_fixtures(self):
        records = [
            {"type": "session", "version": 3, "id": "bounded-session"},
            {
                "type": "message",
                "id": "bounded1",
                "parentId": None,
                "message": {"role": "user", "content": "x" * 256},
            },
        ]
        path = self.write_session("bounded.jsonl", records)

        with mock.patch.object(pi_session, "MAX_JSONL_LINE_CHARS", 128):
            self.assertEqual(pi_session.active_entries(path), [])
        with mock.patch.object(pi_session, "MAX_PARSE_FILE_BYTES", 64):
            self.assertIsNone(pi_session.parse_session_jsonl(path))

    def test_json_decoding_rejects_oversized_numbers_and_constants(self):
        invalid_values = {
            "integer": "1" * 5_000,
            "float": "1" * 5_000 + ".0",
            "nan": "NaN",
            "infinity": "Infinity",
            "negative-infinity": "-Infinity",
        }
        valid_header = '{"type":"session","version":3,"id":"strict-session"}\n'

        for name, value in invalid_values.items():
            with self.subTest(location="header", value=name):
                path = self.session_root / f"header-{name}.jsonl"
                path.write_text(
                    '{"type":"session","version":3,'
                    f'"id":"strict-session","extra":{value}}}\n',
                    encoding="utf-8",
                )
                self.assertFalse(pi_session.is_pi_session_path(path))

            with self.subTest(location="record", value=name):
                path = self.session_root / f"record-{name}.jsonl"
                path.write_text(
                    valid_header
                    + '{"type":"message","id":"strict01","parentId":null,'
                    f'"extra":{value},"message":{{"role":"user","content":"test"}}}}\n',
                    encoding="utf-8",
                )
                self.assertEqual(pi_session.active_entries(path), [])


class SessionMetricsTests(AuthorizedSessionTestCase):
    def test_maps_finalized_usage_models_cost_and_tool_arguments(self):
        parsed = pi_session.parse_session_jsonl(self.fixture("pi-session-linear.jsonl"))

        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed["version"], 3)
        self.assertEqual(parsed["slug"], "11111111-1111-4111-8111-111111111111")
        self.assertEqual(parsed["runtime"], "pi")
        self.assertEqual(parsed["token_source"], "pi_usage")
        self.assertFalse(parsed["estimated"])
        self.assertEqual(parsed["total_input_tokens"], 815)
        self.assertEqual(parsed["total_output_tokens"], 30)
        self.assertEqual(parsed["total_cache_read"], 650)
        self.assertEqual(parsed["total_cache_create"], 15)
        self.assertEqual(parsed["total_cache_create_1h"], 4)
        self.assertEqual(parsed["total_cache_create_5m"], 11)
        self.assertEqual(parsed["cost_usd"], 0.016)
        self.assertEqual(parsed["provider"], "openai-codex")
        self.assertEqual(parsed["model"], "gpt-5.6")
        self.assertEqual(parsed["message_count"], 3)
        self.assertEqual(parsed["api_calls"], 2)
        self.assertEqual(parsed["tool_calls"], {"Read": 1, "external_search": 1})
        self.assertEqual(parsed["model_usage"], {"gpt-5.6": 195})
        self.assertEqual(
            parsed["model_usage_breakdown"],
            {
                "gpt-5.6": {
                    "fresh_input": 150,
                    "cache_read": 650,
                    "cache_create": 15,
                    "cache_create_1h": 4,
                    "cache_create_5m": 11,
                    "output": 30,
                }
            },
        )
        self.assertEqual(parsed["reported_input_tokens"], 150)
        self.assertEqual(parsed["reported_output_tokens"], 30)
        self.assertEqual(parsed["reported_model_usage"], {"gpt-5.6": 180})
        self.assertEqual(
            sum(parsed["reported_model_usage"].values()),
            parsed["reported_input_tokens"] + parsed["reported_output_tokens"],
        )
        self.assertEqual(
            sum(parsed["model_usage"].values()),
            sum(
                parts["fresh_input"] + parts["cache_create"] + parts["output"]
                for parts in parsed["model_usage_breakdown"].values()
            ),
        )

    def test_uses_only_usage_from_the_active_branch(self):
        parsed = pi_session.parse_session_jsonl(self.fixture("pi-session-branched.jsonl"))

        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed["total_input_tokens"], 71)
        self.assertEqual(parsed["total_output_tokens"], 11)
        self.assertEqual(parsed["message_count"], 4)
        self.assertEqual(parsed["model"], "gpt-active")
        self.assertNotIn("wrong-model", parsed["model_usage"])
        self.assertEqual(parsed["tool_calls"], {})

    def test_returns_finalized_assistant_turns_without_streaming_dedup(self):
        turns = pi_session.parse_session_turns(self.fixture("pi-session-linear.jsonl"))

        self.assertEqual(len(turns), 2)
        self.assertEqual(
            turns[0],
            {
                "turn_index": 0,
                "role": "assistant",
                "input_tokens": 500,
                "output_tokens": 20,
                "cache_read": 400,
                "cache_creation": 10,
                "cache_creation_1h": 4,
                "cache_creation_5m": 6,
                "model": "gpt-5.6",
                "provider": "openai-codex",
                "timestamp": "2026-09-03T10:00:04.000Z",
                "gap_since_prev_seconds": None,
                "tools_used": ["Read", "external_search"],
                "cost_usd": 0.01,
                "cost_source": "pi_usage",
                "estimated": False,
            },
        )
        self.assertEqual(turns[1]["turn_index"], 1)
        self.assertEqual(turns[1]["input_tokens"], 300)
        self.assertEqual(turns[1]["cache_creation"], 5)
        self.assertEqual(turns[1]["cache_creation_1h"], 0)
        self.assertEqual(turns[1]["cache_creation_5m"], 5)
        self.assertEqual(turns[1]["gap_since_prev_seconds"], 3)
        self.assertEqual(turns[1]["tools_used"], [])

    def test_naive_timestamps_are_unavailable_in_aware_sessions(self):
        naive_header = self.write_session(
            "naive-header.jsonl",
            [
                {
                    "type": "session",
                    "version": 3,
                    "id": "naive-header",
                    "timestamp": "2026-09-03T12:00:00",
                },
                {
                    "type": "message",
                    "id": "header01",
                    "parentId": None,
                    "timestamp": "2026-09-03T12:01:00Z",
                    "message": {
                        "role": "assistant",
                        "content": [],
                        "usage": {"cost": {"total": 1.0}},
                    },
                },
            ],
        )
        parsed = pi_session.parse_session_jsonl(naive_header)
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed["first_ts"], "2026-09-03T12:01:00+00:00")

        naive_entry = self.write_session(
            "naive-entry.jsonl",
            [
                {
                    "type": "session",
                    "version": 3,
                    "id": "naive-entry",
                    "timestamp": "2026-09-03T12:00:00Z",
                },
                {
                    "type": "message",
                    "id": "entry001",
                    "parentId": None,
                    "timestamp": "2026-09-03T12:01:00Z",
                    "message": {
                        "role": "assistant",
                        "content": [],
                        "usage": {"cost": {"total": 1.0}},
                    },
                },
                {
                    "type": "message",
                    "id": "entry002",
                    "parentId": "entry001",
                    "timestamp": "2026-09-03T12:02:00",
                    "message": {
                        "role": "assistant",
                        "content": [],
                        "usage": {"cost": {"total": 1.0}},
                    },
                },
            ],
        )
        parsed = pi_session.parse_session_jsonl(naive_entry)
        turns = pi_session.parse_session_turns(naive_entry)
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed["duration_minutes"], 1.0)
        self.assertIsNone(turns[1]["timestamp"])
        self.assertIsNone(turns[1]["gap_since_prev_seconds"])

    def test_cache_write_one_hour_is_bounded_by_total_cache_write(self):
        records = [
            {"type": "session", "version": 3, "id": "cache-session"},
            {
                "type": "message",
                "id": "cache001",
                "parentId": None,
                "message": {"role": "user", "content": "cache test"},
            },
            {
                "type": "message",
                "id": "cache002",
                "parentId": "cache001",
                "message": {
                    "role": "assistant",
                    "content": [],
                    "model": "cache-model",
                    "usage": {
                        "input": 1,
                        "output": 2,
                        "cacheRead": 3,
                        "cacheWrite": 5,
                        "cacheWrite1h": 99,
                    },
                },
            },
        ]
        path = self.write_session("cache.jsonl", records)

        parsed = pi_session.parse_session_jsonl(path)
        turns = pi_session.parse_session_turns(path)

        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed["total_cache_create_1h"], 5)
        self.assertEqual(parsed["total_cache_create_5m"], 0)
        self.assertEqual(
            parsed["model_usage_breakdown"]["cache-model"]["cache_create_1h"],
            5,
        )
        self.assertEqual(turns[0]["cache_creation_1h"], 5)
        self.assertEqual(turns[0]["cache_creation_5m"], 0)

    def test_non_finite_usage_is_rejected_without_escaping_results(self):
        records = [
            {"type": "session", "version": 3, "id": "numeric-session"},
            {
                "type": "message",
                "id": "numeric1",
                "parentId": None,
                "message": {"role": "user", "content": "numeric test"},
            },
            {
                "type": "message",
                "id": "numeric2",
                "parentId": "numeric1",
                "message": {
                    "role": "assistant",
                    "content": [],
                    "model": "numeric-model",
                    "usage": {
                        "input": "Infinity",
                        "output": "NaN",
                        "cacheRead": "-Infinity",
                        "cacheWrite": "Infinity",
                        "cacheWrite1h": "Infinity",
                        "cost": {"total": "Infinity"},
                    },
                },
            },
        ]
        path = self.write_session("numeric.jsonl", records)

        parsed = pi_session.parse_session_jsonl(path)
        turns = pi_session.parse_session_turns(path)
        quality = pi_session.parse_jsonl_for_quality(path)

        self.assertIsNotNone(parsed)
        self.assertIsNotNone(quality)
        assert parsed is not None
        self.assertEqual(parsed["total_input_tokens"], 0)
        self.assertEqual(parsed["total_output_tokens"], 0)
        self.assertEqual(parsed["cost_usd"], 0.0)
        self.assertEqual(turns[0]["input_tokens"], 0)
        self.assertEqual(turns[0]["cost_usd"], 0.0)
        json.dumps(parsed, allow_nan=False)
        json.dumps(turns, allow_nan=False)
        json.dumps(quality, allow_nan=False)

    def test_finite_message_costs_cannot_overflow_the_session_total(self):
        records = [
            {"type": "session", "version": 3, "id": "overflow-session"},
            {
                "type": "message",
                "id": "overflow1",
                "parentId": None,
                "message": {
                    "role": "assistant",
                    "content": [],
                    "usage": {"cost": {"total": 1e308}},
                },
            },
            {
                "type": "message",
                "id": "overflow2",
                "parentId": "overflow1",
                "message": {
                    "role": "assistant",
                    "content": [],
                    "usage": {"cost": {"total": 1e308}},
                },
            },
        ]
        path = self.write_session("cost-overflow.jsonl", records)

        self.assertIsNone(pi_session.parse_session_jsonl(path))
        self.assertTrue(
            all(math.isfinite(turn["cost_usd"]) for turn in pi_session.parse_session_turns(path))
        )

    def test_session_metrics_read_the_file_once(self):
        path = self.fixture("pi-session-linear.jsonl")
        with mock.patch.object(
            pi_session,
            "_read_session",
            wraps=pi_session._read_session,
        ) as read_session:
            self.assertIsNotNone(pi_session.parse_session_jsonl(path))

        self.assertEqual(read_session.call_count, 1)


class QualityParserTests(AuthorizedSessionTestCase):
    def test_extracts_quality_signals_from_pi_messages(self):
        quality = pi_session.parse_jsonl_for_quality(
            self.fixture("pi-session-linear.jsonl")
        )

        self.assertIsNotNone(quality)
        assert quality is not None
        self.assertEqual([item[1] for item in quality["reads"]], ["src/app.py"])
        self.assertEqual(quality["writes"], [])
        self.assertEqual(len(quality["messages"]), 3)
        self.assertEqual(quality["tool_calls"], 2)
        self.assertEqual(quality["compactions"], 0)
        self.assertEqual(quality["context_tokens"], 305)
        self.assertEqual(quality["model"], "gpt-5.6")
        self.assertEqual(quality["topic"], "the Pi session parser?")
        self.assertEqual(
            [item[1] for item in quality["tool_results"]],
            ["call-read", "call-search"],
        )
        self.assertTrue(quality["tool_result_meta"][0]["is_failure"])

    def test_compaction_resets_signals_and_materializes_retained_tail(self):
        quality = pi_session.parse_jsonl_for_quality(
            self.fixture("pi-session-compacted.jsonl")
        )

        self.assertIsNotNone(quality)
        assert quality is not None
        self.assertEqual(quality["compactions"], 1)
        self.assertEqual([item[1] for item in quality["reads"]], ["retained.py"])
        self.assertEqual([item[1] for item in quality["writes"]], ["later.py"])
        self.assertEqual(
            [item[1] for item in quality["tool_results"]],
            ["call-retained", "call-later"],
        )
        self.assertEqual([item[1] for item in quality["messages"]], [
            "user", "assistant", "user", "assistant"
        ])
        self.assertNotIn("old.py", repr(quality))
        self.assertEqual(quality["context_tokens"], 123)
        self.assertEqual(quality["model"], "gpt-later")
        self.assertEqual(len(quality["compaction_ratios"]), 1)
        self.assertLess(quality["compaction_ratios"][0]["ratio"], 1)

    def test_legacy_compaction_materializes_first_kept_entry_range(self):
        records = [
            json.loads(line)
            for line in (FIXTURES / "pi-session-compacted.jsonl").read_text(
                encoding="utf-8"
            ).splitlines()
        ]
        compaction = next(record for record in records if record["type"] == "compaction")
        compaction.pop("retainedTail")
        compaction["firstKeptEntryId"] = "10000002"
        path = self.write_session("legacy-compaction.jsonl", records)

        quality = pi_session.parse_jsonl_for_quality(path)
        state = pi_session.extract_session_state(path)
        outputs = pi_session.iter_tool_outputs(path, min_chars=0)

        self.assertIsNotNone(quality)
        self.assertIsNotNone(state)
        assert quality is not None
        assert state is not None
        self.assertEqual([item[1] for item in quality["reads"]], ["old.py"])
        self.assertEqual(quality["tool_calls"], 2)
        self.assertEqual(state["recent_reads"], ["old.py"])
        self.assertEqual(
            [item["tool_use_id"] for item in outputs],
            ["call-old", "call-later"],
        )

    def test_empty_retained_tail_is_authoritative(self):
        records = [
            json.loads(line)
            for line in (FIXTURES / "pi-session-compacted.jsonl").read_text(
                encoding="utf-8"
            ).splitlines()
        ]
        compaction = next(record for record in records if record["type"] == "compaction")
        compaction["retainedTail"] = []
        compaction["firstKeptEntryId"] = "10000002"
        path = self.write_session("empty-retained-tail.jsonl", records)

        quality = pi_session.parse_jsonl_for_quality(path)
        state = pi_session.extract_session_state(path)
        outputs = pi_session.iter_tool_outputs(path, min_chars=0)

        self.assertIsNotNone(quality)
        self.assertIsNotNone(state)
        assert quality is not None
        assert state is not None
        self.assertEqual(quality["reads"], [])
        self.assertEqual(quality["tool_calls"], 1)
        self.assertEqual(state["recent_reads"], [])
        self.assertEqual(
            [item["tool_use_id"] for item in outputs],
            ["call-later"],
        )
        self.assertNotIn("old.py", repr((quality, state, outputs)))

    def test_retained_persisted_tool_call_is_not_double_counted(self):
        records = [
            json.loads(line)
            for line in (FIXTURES / "pi-session-compacted.jsonl").read_text(
                encoding="utf-8"
            ).splitlines()
        ]
        compaction = next(record for record in records if record["type"] == "compaction")
        compaction["retainedTail"] = [
            record["message"]
            for record in records
            if record.get("id") in {"10000002", "10000003", "10000004"}
        ]
        path = self.write_session("retained-persisted-call.jsonl", records)

        quality = pi_session.parse_jsonl_for_quality(path)
        metrics = pi_session.parse_session_jsonl(path)
        outputs = pi_session.iter_tool_outputs(path, min_chars=0)

        self.assertIsNotNone(quality)
        self.assertIsNotNone(metrics)
        assert quality is not None
        assert metrics is not None
        self.assertEqual(quality["tool_calls"], 2)
        self.assertEqual([item[1] for item in quality["reads"]], ["old.py"])
        self.assertEqual(
            [item[1] for item in quality["tool_results"]],
            ["call-old", "call-later"],
        )
        self.assertEqual(metrics["tool_calls"], {"Read": 1, "Write": 1})
        self.assertEqual(
            [item["tool_use_id"] for item in outputs],
            ["call-old", "call-later"],
        )


class ContinuityAndOutputTests(AuthorizedSessionTestCase):
    def test_extracts_checkpoint_state_from_materialized_context(self):
        state = pi_session.extract_session_state(
            self.fixture("pi-session-compacted.jsonl")
        )

        self.assertIsNotNone(state)
        assert state is not None
        self.assertEqual(state["active_files"], [("later.py", "modified", "")])
        self.assertEqual(state["recent_reads"], ["retained.py"])
        self.assertIn(
            "Retained reply because this decision matters",
            state["decisions"],
        )
        self.assertNotIn("old.py", repr(state))
        self.assertEqual(state["agent_state"], [])
        self.assertEqual(state["todos"], [])
        self.assertIsNone(state["active_plan"])
        self.assertEqual(
            state["current_step"],
            {"last_user": "later request?", "last_assistant": "Later reply."},
        )

    def test_extracts_questions_decisions_and_recent_reads(self):
        state = pi_session.extract_session_state(
            self.fixture("pi-session-linear.jsonl")
        )

        self.assertIsNotNone(state)
        assert state is not None
        self.assertEqual(state["recent_reads"], ["src/app.py"])
        self.assertTrue(any("parser?" in item for item in state["open_questions"]))
        self.assertTrue(any("decided" in item for item in state["decisions"]))
        self.assertEqual(state["current_step"]["last_assistant"], "The parser is ready.")

    def test_iterates_only_large_or_high_signal_materialized_tool_outputs(self):
        path = self.fixture("pi-session-linear.jsonl")
        outputs = pi_session.iter_tool_outputs(
            path,
            min_chars=1_000,
        )

        self.assertEqual(len(outputs), 1)
        self.assertEqual(outputs[0]["tool_use_id"], "call-read")
        self.assertEqual(outputs[0]["tool_name"], "Read")
        self.assertEqual(outputs[0]["tool_type"], "read")
        self.assertEqual(outputs[0]["command_or_path"], "src/app.py")
        self.assertIn("error: sample failure", outputs[0]["output"])

        latest = pi_session.iter_tool_outputs(
            path,
            min_chars=0,
            max_outputs=1,
        )
        self.assertEqual([item["tool_use_id"] for item in latest], ["call-search"])

        compacted = pi_session.iter_tool_outputs(
            self.fixture("pi-session-compacted.jsonl"),
            min_chars=0,
        )
        self.assertEqual(
            [item["tool_use_id"] for item in compacted],
            ["call-retained", "call-later"],
        )
        self.assertNotIn("old output", repr(compacted))


if __name__ == "__main__":
    unittest.main()
