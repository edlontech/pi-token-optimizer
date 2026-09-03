import json
import os
import sys
import time


request = json.loads(sys.stdin.read())
log_path = os.environ.get("TOKEN_OPTIMIZER_TEST_LOG")
if log_path:
    with open(log_path, "a", encoding="utf-8") as log:
        log.write(json.dumps(request) + "\n")

delay_ms = request.get("args", {}).get("delayMs", 0)
if delay_ms:
    time.sleep(delay_ms / 1000)

print(json.dumps({
    "protocolVersion": 1,
    "ok": True,
    "data": {
        "request": request,
        "environment": dict(os.environ),
    },
}))
