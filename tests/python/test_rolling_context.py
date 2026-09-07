"""Exercise rolling compression at the real one-shot bridge boundary."""

import json
import os
import subprocess
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

from python import pi_bridge


class RollingContextTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "agent"
        self.data = self.home / "token-optimizer" / "data"
        self.data.mkdir(parents=True)
        self.config = self.home / "token-optimizer" / "config.json"
        self.config.write_text(json.dumps({
            "schemaVersion": 1, "enabled": True,
            "consent": {"granted": True, "noticeVersion": 1},
        }))
        self.environment = {
            "HOME": str(self.root), "PATH": os.environ.get("PATH", ""),
            "PYTHONDONTWRITEBYTECODE": "1", "TOKEN_OPTIMIZER_PI_HOME": str(self.home),
            "TOKEN_OPTIMIZER_NO_PROC_SCAN": "1",
        }
        self.archive_id = "rolling_" + "a" * 64
        self.text = "start\n" + "export const value = 42;\n" * 500 + "end"
        self.request = {
            "protocolVersion": 1, "action": "compress_context",
            "session": {"id": "rolling-test", "cwd": str(self.root)},
            "args": {"results": [{"id": self.archive_id, "name": "read", "text": self.text}]},
        }

    def invoke(self, request=None):
        completed = subprocess.run(
            [sys.executable, str(Path(pi_bridge.__file__).resolve())],
            input=json.dumps(self.request if request is None else request),
            text=True, capture_output=True, env=self.environment, cwd=self.root,
            timeout=10, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stderr, "")
        return json.loads(completed.stdout)

    def test_redacts_before_storage_and_preview_and_reuses_unchanged_archives(self):
        credential = "AKIA" + "A" * 16
        self.request["args"]["results"][0]["text"] = credential + "\n" + self.text
        first = self.invoke()
        replacements = first["data"]["replacements"]
        self.assertEqual(len(replacements), 1)
        self.assertNotIn(credential, replacements[0]["text"])
        session_dir = self.data / "tool-archive" / "rolling-test"
        entry_path = session_dir / (self.archive_id + ".json")
        entry = json.loads(entry_path.read_text())
        self.assertNotIn(credential, entry["response"])
        self.assertIn(self.text, entry["response"])
        self.assertEqual(entry_path.stat().st_mode & 0o777, 0o600)
        before = entry_path.stat().st_mtime_ns
        manifest = (session_dir / "manifest.jsonl").read_bytes()
        self.assertEqual(self.invoke(), first)
        self.assertEqual(entry_path.stat().st_mtime_ns, before)
        self.assertEqual((session_dir / "manifest.jsonl").read_bytes(), manifest)
        expansion = self.invoke({
            "protocolVersion": 1, "action": "expand", "session": self.request["session"],
            "args": {"archiveId": self.archive_id},
        })
        self.assertEqual(expansion["data"]["text"], entry["response"])
        entry_path.unlink()
        self.assertEqual(self.invoke(), first, "missing archives can be rebuilt from unchanged source context")
        self.assertEqual(json.loads(entry_path.read_text())["response"], entry["response"])

    def test_rolling_expansion_does_not_log_an_unearned_reexpansion_debit(self):
        self.assertEqual(len(self.invoke()["data"]["replacements"]), 1)
        self.invoke({
            "protocolVersion": 1, "action": "expand", "session": self.request["session"],
            "args": {"archiveId": self.archive_id},
        })
        database = self.data / "trends.db"
        if database.exists():
            with sqlite3.connect(database) as connection:
                count = connection.execute(
                    "SELECT count(*) FROM savings_events WHERE event_type='tool_archive_reexpand'"
                ).fetchone()[0]
            self.assertEqual(count, 0, "rolling compression never credited arrival savings")

    def test_retention_pruning_and_symlink_destinations_never_emit_dangling_references(self):
        self.environment["TOKEN_OPTIMIZER_ARCHIVE_RETENTION_MAX_BYTES"] = "1"
        self.assertEqual(self.invoke()["data"]["replacements"], [])
        del self.environment["TOKEN_OPTIMIZER_ARCHIVE_RETENTION_MAX_BYTES"]
        outside = self.root / "outside"
        outside.mkdir()
        archive_root = self.data / "tool-archive"
        if archive_root.exists():
            archive_root.rename(self.root / "old-archives")
        archive_root.symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.invoke()["data"]["replacements"], [])
        self.assertEqual(list(outside.iterdir()), [])

    def test_disabled_and_exempt_tools_leave_source_results_unchanged(self):
        self.environment["TOKEN_OPTIMIZER_ARCHIVE_EXEMPT_TOOLS"] = "read"
        self.assertEqual(self.invoke()["data"]["replacements"], [])
        del self.environment["TOKEN_OPTIMIZER_ARCHIVE_EXEMPT_TOOLS"]
        config = json.loads(self.config.read_text())
        config["enabled"] = False
        self.config.write_text(json.dumps(config))
        self.assertFalse(self.invoke()["data"]["active"])
        self.assertFalse((self.data / "tool-archive").exists())

    def test_protocol_rejects_invalid_ids_duplicates_and_oversized_batches(self):
        pi_bridge.parse_request(self.request)
        original = self.request["args"]["results"][0]
        for results in (
            [], [original, original],
            [dict(original, id="../escape")],
            [dict(original, id=self.archive_id + "\n")],
            [dict(original, text="small")],
            [dict(original, text="x" * (2 * 1024 * 1024 + 1))],
            [dict(original, text="\x00" + self.text)],
            [dict(original, extra=True)],
            [dict(original, id="rolling_" + f"{index:064x}") for index in range(33)],
        ):
            with self.subTest(results=len(results)):
                with self.assertRaises(pi_bridge.ProtocolError):
                    pi_bridge.parse_request(dict(self.request, args={"results": results}))
