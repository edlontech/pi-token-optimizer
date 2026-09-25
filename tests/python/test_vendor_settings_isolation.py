"""Keep upstream settings lookups isolated from Pi's runtime."""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


RUNTIME_ENV = (
    Path(__file__).parents[2]
    / "vendor/token-optimizer/skills/token-optimizer/scripts/runtime_env.py"
)


class VendorSettingsIsolationTests(unittest.TestCase):
    def test_pi_does_not_read_claude_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            claude_home = Path(directory) / ".claude"
            claude_home.mkdir()
            (claude_home / "settings.json").write_text(
                json.dumps({"env": {"TOKEN_OPTIMIZER_REDACT_PATTERNS_FILE": "/foreign"}}),
                encoding="utf-8",
            )
            spec = importlib.util.spec_from_file_location("vendor_runtime_env", RUNTIME_ENV)
            runtime_env = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(runtime_env)
            env = {"TOKEN_OPTIMIZER_RUNTIME": "pi", "CLAUDE_CONFIG_DIR": str(claude_home)}
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual(runtime_env.settings_env_value("TOKEN_OPTIMIZER_REDACT_PATTERNS_FILE"), "")

            runtime_env.detect_runtime.cache_clear()
            env["TOKEN_OPTIMIZER_RUNTIME"] = "claude"
            with mock.patch.dict(os.environ, env, clear=True):
                self.assertEqual(runtime_env.settings_env_value("TOKEN_OPTIMIZER_REDACT_PATTERNS_FILE"), "/foreign")


if __name__ == "__main__":
    unittest.main()
