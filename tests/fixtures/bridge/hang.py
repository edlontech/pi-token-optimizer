import json
import os
import signal
import subprocess
import sys
import time


if len(sys.argv) > 1 and sys.argv[1] == "--descendant":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if len(sys.argv) > 2 and sys.argv[2] == "escaped":
        time.sleep(0.75)
        raise SystemExit(0)
    while True:
        time.sleep(1)

request = json.loads(sys.stdin.read())
mode = request.get("args", {}).get("mode")
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen(
    [sys.executable, __file__, "--descendant", mode or "grouped"],
    start_new_session=mode == "escaped",
)
pid_path = os.environ.get("TOKEN_OPTIMIZER_TEST_PID_FILE")
if pid_path:
    parent_pid = os.getpid()
    if parent_pid <= 0 or child.pid <= 0:
        raise RuntimeError("Bridge fixture received an invalid process id")
    temp_path = f"{pid_path}.{parent_pid}.tmp"
    with open(temp_path, "w", encoding="utf-8") as output:
        output.write(f"{parent_pid} {child.pid}\n")
    os.replace(temp_path, pid_path)

while True:
    time.sleep(1)
