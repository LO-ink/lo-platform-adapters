"""Exercise the default command of an already-built emulator image; never publish it."""

import argparse
import json
import subprocess
import time
import urllib.error
import urllib.request


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, timeout=60).strip()


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("--version", default="0.1.0")
    args = parser.parse_args()
    image_id = docker("image", "inspect", "--format", "{{.Id}}", args.image)
    container = docker("create", "--publish", "127.0.0.1::8080", image_id)
    try:
        docker("start", container)
        binding = json.loads(docker("inspect", container))[0]["NetworkSettings"]["Ports"]["8080/tcp"]
        check(len(binding) == 1 and binding[0]["HostIp"] == "127.0.0.1", "Container must bind loopback only")
        base = "http://127.0.0.1:" + binding[0]["HostPort"] + "/bot123456:" + "A" * 43 + "/"

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def post(method, fields):
            request = urllib.request.Request(base + method, data=json.dumps(fields).encode(), headers={"Content-Type": "application/json"})
            try:
                response = opener.open(request, timeout=2)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, json.load(response)

        deadline = time.monotonic() + 30
        while True:
            try:
                status, identity = post("getMe", {})
                break
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                check(json.loads(docker("inspect", container))[0]["State"]["Running"], "Default container command exited before readiness")
                check(time.monotonic() < deadline, "Default container command did not become ready")
                time.sleep(0.2)
        check(status == 200 and identity.get("ok") is True, "getMe must succeed")
        result = identity["result"]
        check(result["id"] == 7 and result["is_bot"] is True and result["capabilities"]["chat_actions"] is False, "Synthetic identity/capabilities mismatch")
        status, invalid = post("sendMessage", {"chat_id": 7, "text": "synthetic smoke", "unsupported_smoke_field": True})
        check(status == 400 and invalid.get("ok") is False and invalid.get("error_code") == 400 and invalid.get("parameters", {}).get("parameter") == "unsupported_smoke_field", "Unknown parameters must be refused")
        status, stub = post("sendChatAction", {"chat_id": 7, "action": "typing"})
        check(status == 501 and stub.get("ok") is False and stub.get("error_code") == 501, "Stubbed methods must be refused")
        runtime = json.loads(docker("exec", container, "python", "-c", "import os,json,importlib.metadata; print(json.dumps({'uid':os.getuid(),'version':importlib.metadata.version('lo-bot-api-emulator')}))"))
        check(runtime["uid"] == 10001, "Emulator must run as the dedicated non-root user")
        check(runtime["version"] == args.version, "Installed emulator version mismatch")
        check(json.loads(docker("inspect", container))[0]["State"]["Running"], "Container exited during smoke")
        print(json.dumps({"image_id": image_id, **runtime, "checks": ["default-command", "loopback-only", "synthetic-identity", "invalid-parameter-400", "stub-501", "non-root", "installed-version"]}, sort_keys=True))
    finally:
        docker("rm", "--force", container)


if __name__ == "__main__":
    main()
