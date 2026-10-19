"""Bounded synthetic update queues. No production authentication or identity enrichment."""

import asyncio
import copy
import hashlib
import json
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from aiohttp import ClientError, ClientSession, ClientTimeout

KINDS = {"message", "callback_query", "inline_query"}
# Delivery filters accept the server vocabulary, including kinds this fixture cannot enqueue.
ALLOWED_UPDATE_TYPES = {
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
    "business_connection",
    "business_message",
    "edited_business_message",
    "deleted_business_messages",
    "message_reaction",
    "message_reaction_count",
    "inline_query",
    "chosen_inline_result",
    "callback_query",
    "shipping_query",
    "pre_checkout_query",
    "purchased_paid_media",
    "poll",
    "poll_answer",
    "my_chat_member",
    "chat_member",
    "chat_join_request",
    "chat_boost",
    "removed_chat_boost",
}


class UpdateError(Exception):
    def __init__(self, message, status=400):
        self.status = status
        super().__init__(message)


@dataclass
class _Inbox:
    updates: list = field(default_factory=list)
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    delivery: asyncio.Lock = field(default_factory=asyncio.Lock)
    next_id: int = 1
    url: str = ""
    secret: str | None = None
    allowed: list[str] = field(default_factory=list)
    polling: bool = False


def integer(value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise UpdateError("Invalid update polling parameter")
    try:
        result = int(value)
    except ValueError:
        raise UpdateError("Invalid update polling parameter") from None
    if str(result) != str(value) or not minimum <= result <= maximum:
        raise UpdateError("Invalid update polling parameter")
    return result


def allowed_updates(value):
    try:
        value = json.loads(value) if isinstance(value, str) else value
    except ValueError:
        raise UpdateError("Invalid allowed_updates") from None
    if (
        not isinstance(value, list)
        or len(value) > 100
        or any(not isinstance(kind, str) or kind not in ALLOWED_UPDATE_TYPES for kind in value)
    ):
        raise UpdateError("Invalid allowed_updates")
    return value.copy()


class UpdateQueues:
    def __init__(self, *, record, max_updates=1000, max_bots=16, insecure_webhooks=False):
        self._bots: dict[str, _Inbox] = {}
        self.max_updates, self.max_bots = max_updates, max_bots
        self.insecure_webhooks = insecure_webhooks
        self.record = record

    def _state(self, token):
        key = hashlib.sha256(token.encode()).hexdigest()
        if key not in self._bots:
            if len(self._bots) >= self.max_bots:
                raise UpdateError("Fixture bot queue capacity reached", 507)
            self._bots[key] = _Inbox()
        return self._bots[key]

    async def enqueue(self, token, update):
        if not isinstance(token, str) or not token:
            raise UpdateError("A synthetic bot token is required")
        if not isinstance(update, dict) or len(json.dumps(update).encode()) > 65536:
            raise UpdateError("Fixture update must be an object within 64 KiB")
        kinds = set(update) - {"update_id"}
        if len(kinds) != 1 or not kinds <= KINDS or not isinstance(update[next(iter(kinds))], dict):
            raise UpdateError("Fixture updates support message, callback_query or inline_query")
        state = self._state(token)
        async with state.condition:
            if len(state.updates) >= self.max_updates:
                raise UpdateError("Fixture update capacity reached", 507)
            update = copy.deepcopy(update)
            identity = integer(update.get("update_id", state.next_id), state.next_id, 2**63 - 1)
            update["update_id"] = identity
            state.next_id = identity + 1
            state.updates.append(update)
            state.condition.notify_all()
        self.record(
            {"event": "enqueue", "update_ids": [identity], "update_kind": next(iter(kinds))}
        )
        await self.deliver(token)
        return identity

    async def poll(self, token, fields, *, disconnected=None):
        state = self._state(token)
        limit = integer(fields.get("limit", 100), 1, 100)
        timeout = integer(fields.get("timeout", 0), 0, 50)
        offset = integer(fields.get("offset", 0), -(2**63) + 1, 2**63 - 1)
        selected = (
            allowed_updates(fields["allowed_updates"]) if "allowed_updates" in fields else None
        )
        deadline = asyncio.get_running_loop().time() + timeout
        async with state.condition:
            if state.url:
                raise UpdateError("Conflict: webhook is active", 409)
            if state.polling:
                raise UpdateError("Conflict: another getUpdates request is active", 409)
            state.polling = True
            try:
                if disconnected is not None and disconnected():
                    raise asyncio.CancelledError
                if selected is not None:
                    state.allowed = selected
                if offset < 0:
                    state.updates = state.updates[offset:]
                elif offset:
                    state.updates = [item for item in state.updates if item["update_id"] >= offset]
                while True:
                    if disconnected is not None and disconnected():
                        raise asyncio.CancelledError
                    if state.url:
                        raise UpdateError("Conflict: webhook is active", 409)
                    results = [
                        item
                        for item in state.updates
                        if not state.allowed or any(kind in item for kind in state.allowed)
                    ][:limit]
                    if results:
                        return copy.deepcopy(results)
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        return []
                    try:
                        await asyncio.wait_for(
                            state.condition.wait(),
                            min(remaining, 0.1) if disconnected is not None else remaining,
                        )
                    except TimeoutError:
                        continue
            finally:
                state.polling = False

    async def set_webhook(self, token, fields):
        state = self._state(token)
        url = fields.get("url", "")
        if not isinstance(url, str):
            raise UpdateError("Invalid webhook URL")
        parsed = urlsplit(url)
        if url and (
            url.strip() != url
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.fragment
            or any(ord(char) < 33 or ord(char) == 127 for char in url)
            or parsed.scheme != "https"
            and not (
                self.insecure_webhooks
                and parsed.scheme == "http"
                and parsed.hostname in ("127.0.0.1", "localhost", "::1")
            )
        ):
            raise UpdateError("Use HTTPS or explicitly enabled loopback webhook HTTP")
        secret = fields.get("secret_token")
        if secret is not None and (
            not isinstance(secret, str)
            or not 1 <= len(secret) <= 256
            or any(not (c.isascii() and (c.isalnum() or c in "_-")) for c in secret)
        ):
            raise UpdateError("Invalid webhook secret")
        selected = (
            allowed_updates(fields["allowed_updates"]) if "allowed_updates" in fields else None
        )
        if "max_connections" in fields:
            integer(fields["max_connections"], 1, 100)
        drop = fields.get("drop_pending_updates", False)
        if type(drop) is not bool and drop not in ("true", "false"):
            raise UpdateError("Invalid drop_pending_updates")
        async with state.delivery, state.condition:
            state.url, state.secret = url, secret
            if selected is not None:
                state.allowed = selected
            if drop is True or drop == "true":
                state.updates.clear()
            state.condition.notify_all()
        await self.deliver(token)
        return True

    def info(self, token):
        state = self._state(token)
        return {
            "url": state.url,
            "has_custom_certificate": False,
            "pending_update_count": len(state.updates),
            "allowed_updates": state.allowed.copy(),
        }

    async def deliver(self, token):
        state = self._state(token)
        delivered = 0
        async with state.delivery:
            while state.url:
                item = next(
                    (
                        item
                        for item in state.updates
                        if not state.allowed or any(kind in item for kind in state.allowed)
                    ),
                    None,
                )
                if item is None:
                    break
                headers = {"X-Telegram-Bot-Api-Secret-Token": state.secret} if state.secret else {}
                try:
                    async with ClientSession(timeout=ClientTimeout(total=5)) as client:
                        async with client.post(
                            state.url, json=item, headers=headers, allow_redirects=False
                        ) as response:
                            status = response.status
                except (ClientError, TimeoutError):
                    status = 0
                if 200 <= status < 300:
                    state.updates.remove(item)
                    delivered += 1
                self.record(
                    {"event": "webhook", "status": status, "update_ids": [item["update_id"]]}
                )
                if not 200 <= status < 300:
                    break
        return delivered
