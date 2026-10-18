"""Append-only CI metadata and a fail-closed, streaming journal verdict."""

import json
from pathlib import Path


def verdict(path, *, require_response=False, require_methods=(), allowed_refusals=()):
    counts: dict[str, int] = {}
    refusals: list[dict] = []
    records, malformed = 0, False
    with Path(path).open() as stream:
        while line := stream.readline(65538):
            records += 1
            if len(line) > 65536:
                malformed = True
                while not line.endswith("\n") and (line := stream.readline(65538)):
                    pass
                continue
            if not line.endswith("\n"):
                malformed = True
                continue
            try:
                item = json.loads(line)
                if not isinstance(item, dict):
                    raise ValueError()
                if "update_ids" in item and (
                    not isinstance(item["update_ids"], list)
                    or len(item["update_ids"]) > 100
                    or any(
                        type(identity) is not int or not 0 < identity < 2**63
                        for identity in item["update_ids"]
                    )
                ):
                    raise ValueError()
                if item.get("event") == "enqueue":
                    if not item.get("update_ids") or item.get("update_kind") not in {
                        "message",
                        "callback_query",
                        "inline_query",
                    }:
                        raise ValueError()
                    continue
                if item.get("event") == "webhook" and not item.get("update_ids"):
                    raise ValueError()
                method, status = (
                    ("webhook", item["status"])
                    if item.get("event") == "webhook"
                    else (item["method"], item["status"])
                )
                if not isinstance(method, str) or type(status) is not int:
                    raise ValueError()
                if (
                    status == 0 or 300 <= status <= 599
                ) and f"{method}:{status}" not in allowed_refusals:
                    if len(refusals) < 20:
                        refusals.append({"method": method, "status": status})
                if 200 <= status < 300:
                    counts[method] = counts.get(method, 0) + 1
                elif status != 0 and not 300 <= status <= 599:
                    raise ValueError()
            except (ValueError, TypeError, KeyError):
                malformed = True
    response = any(
        count
        and name
        in {
            "sendMessage",
            "sendPhoto",
            "sendVideo",
            "sendDocument",
            "sendMediaGroup",
            "sendVoice",
            "sendAudio",
            "sendContact",
        }
        for name, count in counts.items()
    )
    missing = sorted(set(require_methods) - counts.keys())
    passed = (
        records > 0
        and not malformed
        and not refusals
        and not missing
        and (response or not require_response)
    )
    return {
        "ok": passed,
        "records": records,
        "malformed": malformed,
        "refusals": refusals,
        "response": response,
        "successful_methods": counts,
        "missing_methods": missing,
    }
