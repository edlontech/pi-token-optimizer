import json
import sys


request = json.loads(sys.stdin.read())
mode = request.get("args", {}).get("mode")

if mode == "extra":
    print('{"protocolVersion":1,"ok":true}')
    print('{"protocolVersion":1,"ok":true}')
elif mode == "oversized":
    print("x" * (65 * 1024))
elif mode == "stderr":
    sys.stderr.write("diagnostic\n" * (128 * 1024))
    print('{"protocolVersion":1,"ok":true}')
elif mode == "expansion":
    print(json.dumps({
        "protocolVersion": 1,
        "ok": True,
        "data": {"text": "x" * (51 * 1024)},
    }))
elif mode == "nonzero":
    sys.exit(7)
else:
    print("not json")
