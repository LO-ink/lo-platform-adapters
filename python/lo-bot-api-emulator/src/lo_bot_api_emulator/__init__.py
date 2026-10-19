"""Request validation fixtures. Storage, authorization and transcoding require live LO."""

import argparse
import json
import math
import os
import re
import sys
from importlib.resources import files
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import web

from .journal import verdict
from .updates import UpdateError, UpdateQueues

CONTRACT = json.loads(files(__package__).joinpath("contract.json").read_text())
MODELED_METHODS = {
    "getMe",
    "getUpdates",
    "getFile",
    "getMyCommands",
    "getWebhookInfo",
    "sendMessage",
    "sendChatAction",
    "sendPhoto",
    "sendVideo",
    "sendDocument",
    "sendVoice",
    "sendAudio",
    "sendMediaGroup",
    "editMessageText",
    "editMessageCaption",
    "editMessageReplyMarkup",
    "setMyCommands",
    "deleteMyCommands",
    "setWebhook",
    "deleteWebhook",
    "setChatMenuButton",
    "deleteMessage",
    "answerCallbackQuery",
    "answerInlineQuery",
}


class ApiRefusal(Exception):
    def __init__(self, description, status=400, parameters=None):
        self.description, self.status, self.parameters = description, status, parameters


class LoBotApiEmulator:
    def __init__(
        self,
        *,
        video_uploads=True,
        single_attach=True,
        video_retry_count=0,
        request_bytes=512 * 1024 * 1024,
        asset_bytes=512 * 1024 * 1024,
        max_assets=100,
        max_history=1000,
        max_parts=32,
        journal=None,
        enable_control=False,
        max_updates=1000,
        max_bots=16,
        allow_insecure_loopback_webhooks=False,
    ):
        for limit in (
            request_bytes,
            asset_bytes,
            max_assets,
            max_history,
            max_parts,
            max_updates,
            max_bots,
        ):
            if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
                raise ValueError("Fixture resource limits must be positive integers")
        self.video_uploads = video_uploads
        self.single_attach = single_attach
        self.video_retry_count = video_retry_count
        self.requests = []
        self.assets = {}
        self.next_id = 1
        self.request_bytes, self.asset_bytes = request_bytes, asset_bytes
        self.max_assets, self.max_history, self.max_parts = max_assets, max_history, max_parts
        self.journal = Path(journal) if journal is not None else None
        self.enable_control = enable_control
        self._update_queues = UpdateQueues(
            record=self._record,
            max_updates=max_updates,
            max_bots=max_bots,
            insecure_webhooks=allow_insecure_loopback_webhooks,
        )

    def app(self):
        app = web.Application(client_max_size=self.request_bytes)
        app.router.add_post("/bot{token}/{method}", self.handle)
        app.router.add_get("/file/bot{token}/{path:.*}", self.download)
        if self.enable_control:
            app.router.add_post("/__fixture/updates", self.control)
            app.router.add_post("/__fixture/deliver", self.control)
        return app

    def _record(self, item):
        if self.journal is not None:
            with os.fdopen(
                os.open(self.journal, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600), "w"
            ) as stream:
                stream.write(json.dumps(item, separators=(",", ":")) + "\n")

    async def enqueue_update(self, update, *, token):
        """Queue an exact synthetic payload; no identity or language fields are invented."""
        return await self._update_queues.enqueue(token, update)

    async def deliver_updates(self, *, token):
        """Explicitly attempt queued webhook deliveries; failures stay queued."""
        return await self._update_queues.deliver(token)

    async def control(self, request):
        try:
            data = bytearray()
            async for chunk in request.content.iter_chunked(8192):
                data.extend(chunk)
                if len(data) > 65536:
                    raise UpdateError("Fixture control request exceeds 64 KiB", 413)
            body = json.loads(data)
            if not isinstance(body, dict) or set(body) - {"token", "update"}:
                raise UpdateError("Invalid fixture control request")
            if not isinstance(body.get("token"), str) or not body["token"]:
                raise UpdateError("A synthetic bot token is required")
            if request.path == "/__fixture/updates":
                result = {
                    "update_id": await self.enqueue_update(body.get("update"), token=body["token"])
                }
            else:
                result = {"delivered": await self._update_queues.deliver(body["token"])}
            return web.json_response({"ok": True, "result": result})
        except UpdateError as error:
            return web.json_response({"ok": False, "description": str(error)}, status=error.status)
        except (ValueError, TypeError, KeyError, UnicodeError):
            return web.json_response(
                {"ok": False, "description": "Malformed fixture control request"}, status=400
            )

    async def download(self, request):
        asset = self.assets.get(request.match_info["path"])
        if asset is None:
            raise web.HTTPNotFound()
        return web.Response(body=asset.get("data", b"fixture"))

    async def read_request(self, request):
        fields, uploads = {}, {}
        if request.content_length is not None and request.content_length > request.client_max_size:
            raise ApiRefusal("Request exceeds the fixture byte limit", 413)
        if request.content_type == "application/json":
            fields = await request.json()
            if not isinstance(fields, dict):
                raise ApiRefusal("Bad Request: expected an object")
        elif request.content_type.startswith("multipart/"):
            reader = await request.multipart()
            total, parts = 0, 0
            async for part in reader:
                parts += 1
                if parts > self.max_parts:
                    raise ApiRefusal("Request exceeds the fixture part limit", 413)
                if not part.name or part.name in fields or part.name in uploads:
                    raise ApiRefusal("Bad Request: duplicate parameter")
                size, data = 0, bytearray()
                while chunk := await part.read_chunk():
                    size += len(chunk)
                    total += len(chunk)
                    if total > request.client_max_size:
                        raise ApiRefusal("Request exceeds the fixture byte limit", 413)
                    if part.filename is not None and size > CONTRACT["limits"]["fileBytes"]:
                        raise ApiRefusal("Bad Request: file is too big")
                    if part.filename is None and size > 64 * 1024:
                        raise ApiRefusal("Request exceeds the fixture field limit", 413)
                    data.extend(chunk)
                if part.filename is None:
                    fields[part.name] = data.decode(part.get_charset(default="utf-8"))
                else:
                    uploads[part.name] = {
                        "filename": part.filename,
                        "data": bytes(data),
                        "size": size,
                    }
        else:
            fields = dict(await request.post())
        return fields, uploads

    def check_asset_capacity(self, sources):
        additions = [source for source in sources if isinstance(source, dict)]
        retained = sum(len(source.get("data", b"")) for source in self.assets.values())
        incoming = sum(len(source.get("data", b"")) for source in additions)
        if (
            len(self.assets) + len(additions) > self.max_assets
            or retained + incoming > self.asset_bytes
        ):
            raise ApiRefusal("Fixture asset capacity reached; start a fresh fixture", 507)

    @staticmethod
    def decoded(value):
        return json.loads(value) if isinstance(value, str) else value

    @staticmethod
    def scalar_text(value):
        # Match the server's top-level Args.String binding, not nested JSON strings.
        if isinstance(value, str):
            return value
        if isinstance(value, (bool, int)) or isinstance(value, float) and math.isfinite(value):
            return json.dumps(value)
        return None

    @staticmethod
    def bound_integer(value):
        # Args.Int64 accepts form integers and exact whole JSON numbers.
        if isinstance(value, bool):
            return None
        if isinstance(value, str):
            if re.fullmatch(r"[+-]?[0-9]+", value.strip()) is None:
                return None
            value = int(value)
        elif isinstance(value, float):
            if not math.isfinite(value) or not value.is_integer() or abs(value) >= 2**53:
                return None
            value = int(value)
        if type(value) is int and -(2**63) <= value < 2**63:
            return value
        return None

    def validate_inline_answer(self, fields):
        query = self.scalar_text(fields.get("inline_query_id"))
        results = self.decoded(fields.get("results"))
        cache = self.bound_integer(fields.get("cache_time"))
        if (
            not query
            or not query.strip()
            or results is not None
            and (not isinstance(results, list) or len(results) > 50)
            or cache is not None
            and cache < 0
        ):
            raise ApiRefusal("Bad Request: invalid inline answer")
        identities = set()
        for item in results or []:
            if not isinstance(item, dict) or any(
                item.get(key) is not None and not isinstance(item[key], str)
                for key in ("type", "id", "title", "photo_file_id", "caption")
            ):
                raise ApiRefusal("Bad Request: invalid inline result")
            identity, kind = item.get("id") or "", item.get("type")
            if (
                not 1 <= len(identity.encode("utf-8")) <= 64
                or identity in identities
                or kind not in ("article", "photo")
            ):
                raise ApiRefusal("Bad Request: invalid inline result ID or type")
            identities.add(identity)
            content = item.get("input_message_content")
            if content is not None or kind == "article":
                text = content.get("message_text") if isinstance(content, dict) else None
                if not isinstance(text, str) or not 1 <= len(text.encode("utf-16-le")) // 2 <= 4096:
                    raise ApiRefusal("Bad Request: invalid inline message text")
            if kind == "article":
                title = item.get("title") or ""
                if not 1 <= len(title.encode("utf-16-le")) // 2 <= 256:
                    raise ApiRefusal("Bad Request: invalid inline title")
            elif len((item.get("caption") or "").encode("utf-16-le")) // 2 > 1024:
                raise ApiRefusal("Bad Request: inline caption is too long")
            reference = item.get("photo_file_id")
            if reference or kind == "photo":
                # Fixture references stand in for the server's signed photo references.
                self.source("photo", reference, {})

    @classmethod
    def validate_callback_answer(cls, fields):
        query = cls.scalar_text(fields.get("callback_query_id"))
        text, url = (cls.scalar_text(fields.get(key, "")) for key in ("text", "url"))
        cache = cls.bound_integer(fields.get("cache_time", 0))
        alert = fields.get("show_alert", False)
        valid_alert = (
            type(alert) is bool
            or type(alert) is int
            and -(2**63) <= alert < 2**63
            or isinstance(alert, str)
            and alert.strip()
            in ("1", "0", "t", "T", "true", "TRUE", "True", "f", "F", "false", "FALSE", "False")
        )
        if (
            not query
            or text is None
            or len(text) > 200
            or url is None
            or cache is None
            or not 0 <= cache <= 86400
            or not valid_alert
        ):
            raise ApiRefusal("Bad Request: invalid callback answer")
        text.encode("utf-8")
        if not url:
            return
        if len(url.encode("utf-8")) > 2048 or any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in url):
            raise ApiRefusal("Bad Request: invalid callback URL")
        # Match Go net/url host/zone escapes without Python's stricter IP/NFKC checks.
        parts = re.fullmatch(
            r"(?:https?|tg)://([^/?#]+)([^?#]*)(?:\?[^#]*)?(?:#(.*))?", url, re.I | re.ASCII
        )
        if parts is None:
            raise ApiRefusal("Bad Request: invalid callback URL")
        host, path, fragment = parts.groups()
        allowed_host = (
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~!$&'()*+,;=:[]<>\""
        )
        bracket = host.rfind("]") if host.startswith("[") else -1
        port = host[bracket + 1 :] if host.startswith("[") else host[host.rfind(":") :]
        if (
            host.startswith("[")
            and bracket < 0
            or (host.startswith("[") or ":" in host)
            and re.fullmatch(r"(?::[0-9]*)?", port) is None
            or any(ord(c) < 128 and c != "%" and c not in allowed_host for c in host)
            or any(re.search(r"%(?![0-9A-Fa-f]{2})", part) for part in (host, path, fragment or ""))
        ):
            raise ApiRefusal("Bad Request: invalid callback URL")
        zone = host.find("%25", 0, bracket) if bracket >= 0 else -1
        for escape in re.finditer(r"%([0-9A-Fa-f]{2})", host):
            byte = int(escape[1], 16)
            in_zone = zone >= 0 and zone <= escape.start() < bracket
            if byte == 37:
                continue
            if (in_zone and chr(byte) not in allowed_host + " ") or (not in_zone and byte < 128):
                raise ApiRefusal("Bad Request: invalid callback URL")

    @staticmethod
    def valid_keyboard_url(value, *, https_only=False):
        if (
            not isinstance(value, str)
            or value.strip() != value
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or re.search(r"%(?![0-9A-Fa-f]{2})", value)
        ):
            return False
        try:
            parsed = urlsplit(value)
            _ = parsed.port
            return (
                parsed.username is None
                and parsed.password is None
                and bool(parsed.hostname)
                and not any(char.isspace() for char in parsed.netloc)
                and parsed.scheme in (("https",) if https_only else ("https", "http", "tg"))
            )
        except ValueError:
            return False

    @classmethod
    def validate_markup(cls, markup, *, private_chat=True):
        try:
            if (
                len(json.dumps(markup, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                > 32768
            ):
                raise ApiRefusal("Bad Request: invalid reply_markup")
        except UnicodeEncodeError:
            raise ApiRefusal("Bad Request: invalid reply_markup") from None
        if "inline_keyboard" in markup:
            if set(markup) != {"inline_keyboard"}:
                raise ApiRefusal("Bad Request: invalid reply_markup")
            rows = markup["inline_keyboard"]
            if not isinstance(rows, list):
                raise ApiRefusal("Bad Request: invalid reply_markup")
            count = 0
            for row in rows:
                if not isinstance(row, list) or not 1 <= len(row) <= 8:
                    raise ApiRefusal("Bad Request: invalid reply_markup")
                count += len(row)
                if count > 100:
                    raise ApiRefusal("Bad Request: invalid reply_markup")
                for button in row:
                    if (
                        not isinstance(button, dict)
                        or not isinstance(button.get("text"), str)
                        or not button["text"]
                        or len(button) != 2
                    ):
                        raise ApiRefusal("Bad Request: invalid reply_markup")
                    action = next(key for key in button if key != "text")
                    value = button[action]
                    valid = False
                    if action == "callback_data":
                        valid = isinstance(value, str) and 1 <= len(value.encode("utf-8")) <= 64
                    elif action == "url":
                        valid = cls.valid_keyboard_url(value)
                    elif action == "web_app":
                        valid = (
                            private_chat
                            and isinstance(value, dict)
                            and set(value) == {"url"}
                            and cls.valid_keyboard_url(value["url"], https_only=True)
                        )
                    elif action == "copy_text":
                        valid = (
                            isinstance(value, dict)
                            and set(value) == {"text"}
                            and isinstance(value["text"], str)
                            and 1 <= len(value["text"]) <= 256
                        )
                    elif action in ("switch_inline_query", "switch_inline_query_current_chat"):
                        valid = isinstance(value, str)
                    if not valid:
                        raise ApiRefusal("Bad Request: invalid reply_markup")
            return
        if "remove_keyboard" in markup:
            if (
                markup["remove_keyboard"] is not True
                or set(markup) - {"remove_keyboard", "selective"}
                or markup.get("selective", False) is not False
            ):
                raise ApiRefusal("Bad Request: invalid reply_markup")
            return
        allowed = {
            "keyboard",
            "is_persistent",
            "resize_keyboard",
            "one_time_keyboard",
            "input_field_placeholder",
            "selective",
        }
        rows = markup.get("keyboard")
        if (
            set(markup) - allowed
            or not isinstance(rows, list)
            or not 1 <= len(rows) <= 12
            or markup.get("selective", False) is not False
            or any(
                name in markup and not isinstance(markup[name], bool)
                for name in ("is_persistent", "resize_keyboard", "one_time_keyboard")
            )
            or not isinstance(markup.get("input_field_placeholder", ""), str)
            or len(markup.get("input_field_placeholder", "")) > 64
        ):
            raise ApiRefusal("Bad Request: invalid reply_markup")
        count = 0
        for row in rows:
            if not isinstance(row, list) or not 1 <= len(row) <= 8:
                raise ApiRefusal("Bad Request: invalid reply_markup")
            for button in row:
                count += 1
                text = (
                    button
                    if isinstance(button, str)
                    else (button.get("text") if isinstance(button, dict) else None)
                )
                if count > 100 or not isinstance(text, str) or not text.strip() or len(text) > 64:
                    raise ApiRefusal("Bad Request: invalid reply_markup")
                if isinstance(button, dict) and set(button) - {
                    "text",
                    "web_app",
                    "request_contact",
                    "request_location",
                }:
                    raise ApiRefusal("Bad Request: invalid reply_markup")
                if isinstance(button, dict):
                    for name in ("request_contact", "request_location"):
                        if name in button and not isinstance(button[name], bool):
                            raise ApiRefusal("Bad Request: invalid reply_markup")
                    contact, location = (
                        button.get("request_contact", False),
                        button.get("request_location", False),
                    )
                    app = button.get("web_app")
                    if (
                        contact
                        and location
                        or (contact or location)
                        and (app is not None or not private_chat)
                    ):
                        raise ApiRefusal("Bad Request: invalid reply_markup")
                    if app is not None and (
                        not isinstance(app, dict)
                        or not cls.valid_keyboard_url(app.get("url"), https_only=True)
                        or len(app["url"].encode("utf-8")) > 512
                    ):
                        raise ApiRefusal("Bad Request: invalid reply_markup")

    def source(self, kind, value, uploads, *, album=False):
        if not album and kind in uploads:
            return uploads[kind]
        if isinstance(value, str) and value.startswith("attach://"):
            if not album and not self.single_attach:
                raise ApiRefusal("Bad Request: " + value[9:] + " is not supported yet")
            upload = uploads.get(value[9:])
            if upload is None:
                raise ApiRefusal("Bad Request: wrong file identifier/HTTP URL specified")
            return upload
        if isinstance(value, str) and value in self.assets:
            return value
        raise ApiRefusal("Bad Request: wrong file identifier/HTTP URL specified")

    def media_message(self, chat, kind, source, caption=None, message_id=None):
        if isinstance(source, dict):
            if source["size"] > CONTRACT["limits"]["photoBytes"] and kind == "photo":
                raise ApiRefusal("Bad Request: file is too big")
            self.check_asset_capacity([source])
            reference = f"fixture-{kind}-{self.next_id}"
            self.assets[reference] = source
        else:
            reference = source
        result = {
            "message_id": message_id or self.next_id,
            "date": 1,
            "chat": {"id": int(chat), "type": "private" if int(chat) > 0 else "group"},
        }
        self.next_id += 1
        asset: dict[str, object] = {"file_id": reference, "file_unique_id": reference + "-unique"}
        if kind == "photo":
            asset.update(width=1, height=1)
            result[kind] = [asset]
        elif kind == "video":
            asset.update(width=1, height=1, duration=1)
            result[kind] = asset
        elif kind in ("voice", "audio"):
            asset["duration"] = 1
            result[kind] = asset
        else:
            result[kind] = asset
        if caption is not None:
            result["caption"] = caption
        return result

    @classmethod
    def validate_reply(cls, fields):
        # Validate the request shape; fixture storage cannot establish target existence.
        if fields.get("reply_parameters") is not None:
            try:
                reply = cls.decoded(fields["reply_parameters"])
            except (ValueError, TypeError):
                raise ApiRefusal("Bad Request: can't parse reply parameters JSON object") from None
            if not isinstance(reply, dict):
                raise ApiRefusal("Bad Request: can't parse reply parameters JSON object")
            for key in reply:
                if key not in ("message_id", "chat_id", "allow_sending_without_reply"):
                    raise ApiRefusal(
                        "Bad Request: reply_parameters." + key + " is not supported yet",
                        parameters={
                            "reason": "unsupported_parameter",
                            "parameter": "reply_parameters." + key,
                        },
                    )
            identity = reply.get("message_id")
            if type(identity) is not int or not 0 < identity < 2**31:
                raise ApiRefusal("Bad Request: message to be replied not found")
            if "chat_id" in reply and (
                isinstance(reply["chat_id"], bool)
                or not isinstance(reply["chat_id"], (int, str))
                or re.fullmatch(r"[+-]?[0-9]+", str(reply["chat_id"])) is None
                or int(reply["chat_id"]) != int(fields["chat_id"])
            ):
                raise ApiRefusal("Bad Request: reply_parameters.chat_id is not supported yet")
            if (
                "allow_sending_without_reply" in reply
                and reply["allow_sending_without_reply"] is not None
                and type(reply["allow_sending_without_reply"]) is not bool
            ):
                raise ApiRefusal("Bad Request: can't parse reply parameters JSON object")
        elif "reply_to_message_id" in fields:
            value = fields["reply_to_message_id"]
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float, str))
                or isinstance(value, str)
                and re.fullmatch(r"[+-]?[0-9]+", value.strip()) is None
                or isinstance(value, float)
                and (not math.isfinite(value) or not value.is_integer())
            ):
                raise ApiRefusal("Bad Request: message to be replied not found")
            try:
                identity = int(value)
            except ValueError:
                raise ApiRefusal("Bad Request: message to be replied not found") from None
            if not 0 < identity < 2**31:
                raise ApiRefusal("Bad Request: message to be replied not found")

    def validate(self, method, fields, uploads):
        definition = CONTRACT["methods"].get(method)
        if definition is None:
            raise ApiRefusal("Not Found: method not found", 404)
        if not definition["implemented"]:
            raise ApiRefusal(
                "Method not implemented: " + method, 501, {"reason": "method_not_implemented"}
            )
        if definition["parameters"] is None:
            # Do not claim a server method passed when this fixture does not model it.
            raise ApiRefusal("Emulator does not model this method: " + method, 501)
        if "method" in uploads or "method" in fields and fields["method"] != method:
            raise ApiRefusal(
                "Bad Request: method must match the request path",
                parameters={"reason": "unsupported_parameter", "parameter": "method"},
            )
        fields.pop("method", None)
        allowed = set(definition["parameters"])
        for key in ("photo", "document", "voice", "audio", "video", "thumbnail"):
            value = fields.get(key)
            if (
                key in allowed
                and isinstance(value, str)
                and value.startswith("attach://")
                and self.single_attach
            ):
                allowed.add(value[9:])
        media = None
        if method == "sendMediaGroup":
            try:
                media = self.decoded(fields.get("media"))
            except (ValueError, TypeError):
                raise ApiRefusal("Bad Request: media must be a JSON array") from None
            if (
                not isinstance(media, list)
                or not CONTRACT["inputMedia"]["minItems"]
                <= len(media)
                <= CONTRACT["inputMedia"]["maxItems"]
            ):
                raise ApiRefusal("Bad Request: media must include 2 to 10 items")
            for index, item in enumerate(media):
                if not isinstance(item, dict):
                    raise ApiRefusal("Bad Request: invalid media item")
                for key in sorted(item):
                    if key not in CONTRACT["inputMedia"]["parameters"]:
                        raise ApiRefusal(
                            "Bad Request: media item "
                            + str(index)
                            + ": "
                            + key
                            + " is not supported yet"
                        )
                value = item.get("media")
                if isinstance(value, str) and value.startswith("attach://"):
                    allowed.add(value[9:])
            types = {item.get("type") for item in media}
            for item in media:
                if item.get("type") not in CONTRACT["inputMedia"]["types"]:
                    raise ApiRefusal(
                        "Bad Request: media type " + str(item.get("type")) + " is not supported yet"
                    )
            if len(types) != 1:
                raise ApiRefusal("Bad Request: a media group must contain items of one type")
            if any(item.get("caption") for item in media[1:]):
                raise ApiRefusal(
                    "Bad Request: only the first item of a media group may carry a caption"
                )
        if not definition.get("allowUnknownParameters"):
            unknown = sorted((set(fields) | set(uploads)) - allowed)
            if unknown:
                raise ApiRefusal(
                    "Bad Request: " + unknown[0] + " is not supported yet",
                    parameters={"reason": "unsupported_parameter", "parameter": unknown[0]},
                )
        if (
            method.startswith("send")
            or method.startswith("editMessage")
            or method == "deleteMessage"
        ):
            chat = fields.get("chat_id")
            try:
                if (
                    isinstance(chat, bool)
                    or not isinstance(chat, (str, int))
                    or str(int(chat)) != str(chat)
                    or not -(2**63) <= int(chat) < 2**63
                    or int(chat) == 0
                ):
                    raise ValueError()
            except (ValueError, TypeError):
                raise ApiRefusal("Bad Request: chat not found") from None
        if method.startswith("editMessage") or method == "deleteMessage":
            message = fields.get("message_id")
            if (
                isinstance(message, bool)
                or not isinstance(message, (str, int))
                or not str(message).isascii()
                or not str(message).isdigit()
                or not 0 < int(message) < 2**63
            ):
                raise ApiRefusal("Bad Request: MESSAGE_ID_INVALID")
        if "reply_parameters" in allowed:
            self.validate_reply(fields)
        if method == "sendChatAction":
            if fields.get("action") not in (
                "typing",
                "choose_sticker",
                "find_location",
                "record_voice",
                "upload_voice",
                "record_video",
                "record_video_note",
                "upload_photo",
                "upload_video",
                "upload_document",
                "upload_video_note",
            ):
                raise ApiRefusal("Bad Request: wrong parameter action in request")
            return True
        markup = fields.get("reply_markup")
        if markup is not None:
            try:
                markup = self.decoded(markup)
            except (TypeError, ValueError):
                raise ApiRefusal("Bad Request: invalid reply_markup") from None
            if not isinstance(markup, dict):
                raise ApiRefusal("Bad Request: invalid reply_markup")
            if method != "sendMessage" and set(markup) != {"inline_keyboard"}:
                raise ApiRefusal("Bad Request: only inline keyboard is supported")
            self.validate_markup(markup, private_chat=int(fields["chat_id"]) > 0)
        if method == "getMe":
            return {
                "id": 7,
                "is_bot": True,
                "first_name": "Fixture",
                "can_join_groups": True,
                "can_read_all_group_messages": False,
                "supports_inline_queries": False,
                "capabilities": {
                    "video_uploads": self.video_uploads,
                    "audio_uploads": False,
                    "single_attach": self.single_attach,
                    "media_groups": True,
                    "chat_actions": True,
                },
            }
        if method == "getUpdates":
            return []
        if method == "getWebhookInfo":
            return {}
        if method == "getFile":
            ref = fields.get("file_id")
            if ref not in self.assets:
                raise ApiRefusal("Bad Request: wrong file_id specified")
            return {"file_id": ref, "file_unique_id": ref + "-unique", "file_path": ref}
        if method == "getMyCommands":
            return []
        if method in (
            "sendMessage",
            "editMessageText",
            "editMessageCaption",
            "editMessageReplyMarkup",
        ):
            text = fields.get("text", "")
            if method in ("sendMessage", "editMessageText") and (
                not isinstance(text, str) or not text.strip()
            ):
                raise ApiRefusal("Bad Request: message text is empty")
            if len(text.encode("utf-16-le")) // 2 > CONTRACT["limits"]["textUtf16"]:
                raise ApiRefusal("Bad Request: message is too long")
            result = {
                "message_id": int(fields["message_id"])
                if method.startswith("editMessage")
                else self.next_id,
                "date": 1,
                "chat": {"id": int(fields["chat_id"]), "type": "private"},
            }
            if method in ("sendMessage", "editMessageText"):
                result["text"] = text
            if markup is not None and "inline_keyboard" in markup:
                result["reply_markup"] = markup
            if method == "editMessageCaption" and "caption" in fields:
                caption = fields["caption"]
                if (
                    not isinstance(caption, str)
                    or len(caption.encode("utf-16-le")) // 2 > CONTRACT["limits"]["captionUtf16"]
                ):
                    raise ApiRefusal("Bad Request: caption is too long")
                result["caption"] = caption
            if method == "sendMessage":
                self.next_id += 1
            return result
        if method == "answerInlineQuery":
            self.validate_inline_answer(fields)
            return True
        if method == "sendMediaGroup":
            assert isinstance(media, list)
            sources = [
                self.source(item["type"], item.get("media"), uploads, album=True) for item in media
            ]
            cached_documents = [
                source
                for item, source in zip(media, sources, strict=True)
                if item["type"] == "document" and isinstance(source, str)
            ]
            if len(cached_documents) != len(set(cached_documents)):
                # Observed core constraint: duplicate document IDs do not form an album.
                raise ApiRefusal("Bad Request: message text is empty")
            for item, source in zip(media, sources, strict=True):
                caption = item.get("caption")
                if caption is not None and (
                    not isinstance(caption, str)
                    or len(caption.encode("utf-16-le")) // 2 > CONTRACT["limits"]["captionUtf16"]
                ):
                    raise ApiRefusal("Bad Request: caption is too long")
                if (
                    item["type"] == "photo"
                    and isinstance(source, dict)
                    and source["size"] > CONTRACT["limits"]["photoBytes"]
                ):
                    raise ApiRefusal("Bad Request: file is too big")
            group_id = self.next_id
            self.check_asset_capacity(sources)
            results = [
                self.media_message(
                    fields["chat_id"], item["type"], source, item.get("caption"), group_id
                )
                for item, source in zip(media, sources, strict=True)
            ]
            for result in results:
                result["media_group_id"] = str(group_id)
            return results
        if method in ("sendPhoto", "sendDocument", "sendVoice", "sendAudio", "sendVideo"):
            kind = method[4:].lower()
            source = self.source(kind, fields.get(kind), uploads)
            if method == "sendVideo":
                if isinstance(source, str):
                    for key in definition["uploadOnly"]:
                        if key in fields or key in uploads:
                            raise ApiRefusal(
                                "Bad Request: "
                                + key
                                + " applies only to an uploaded video, not to a file identifier",
                                parameters={"reason": "upload_only", "parameter": key},
                            )
                elif not self.video_uploads:
                    raise ApiRefusal(
                        "Bad Request: video must be a file identifier",
                        parameters={"reason": "feature_disabled", "parameter": "video"},
                    )
                elif self.video_retry_count:
                    self.video_retry_count -= 1
                    raise ApiRefusal(
                        "Too Many Requests: retry after 10",
                        429,
                        {"retry_after": 10, "safe_to_retry": True},
                    )
                if "thumbnail" in fields and "thumbnail" not in uploads:
                    thumbnail = self.source("thumbnail", fields["thumbnail"], uploads)
                    if not isinstance(thumbnail, dict):
                        raise ApiRefusal("Bad Request: thumbnail must be an uploaded file")
                for key, maximum in (
                    ("duration", CONTRACT["limits"]["videoDurationSeconds"]),
                    ("width", CONTRACT["limits"]["videoSidePixels"]),
                    ("height", CONTRACT["limits"]["videoSidePixels"]),
                ):
                    if key in fields and (
                        str(fields[key]).isdigit() is False or not 0 <= int(fields[key]) <= maximum
                    ):
                        raise ApiRefusal(
                            f"Bad Request: {key} must be an integer between 0 and {maximum}"
                        )
            if kind == "audio" and isinstance(source, dict):
                raise ApiRefusal("Bad Request: audio must be a file identifier")
            caption = fields.get("caption")
            # The server stringifies JSON scalar values, but refuses structures.
            if isinstance(caption, bool):
                caption = "true" if caption else "false"
            elif isinstance(caption, int):
                caption = str(caption)
            elif isinstance(caption, float) and math.isfinite(caption):
                caption = str(caption)
            if caption is not None and (
                not isinstance(caption, str)
                or len(caption.encode("utf-16-le")) // 2 > CONTRACT["limits"]["captionUtf16"]
            ):
                raise ApiRefusal("Bad Request: caption is too long")
            return self.media_message(fields["chat_id"], kind, source, caption)
        if method in (
            "setMyCommands",
            "deleteMyCommands",
            "deleteWebhook",
            "setWebhook",
            "setChatMenuButton",
            "deleteMessage",
            "answerCallbackQuery",
        ):
            if method == "answerCallbackQuery":
                self.validate_callback_answer(fields)
            if method == "setMyCommands":
                commands = self.decoded(fields.get("commands"))
                if not isinstance(commands, list) or len(commands) > 100:
                    raise ApiRefusal("Bad Request: commands must be an array")
            return True
        raise ApiRefusal("Emulator does not model this method: " + method, 501)

    async def handle(self, request):
        method = request.match_info["method"]
        fields, uploads, status = {}, {}, 200
        try:
            fields, uploads = await self.read_request(request)
            result = self.validate(method, fields, uploads)
            token = request.match_info["token"]
            if method == "getUpdates" and not result:
                # Scope disconnect cancellation to long polling, never to committed sends.
                result = await self._update_queues.poll(
                    token,
                    fields,
                    disconnected=lambda: (
                        request.transport is None or request.transport.is_closing()
                    ),
                )
            elif method == "getWebhookInfo":
                result = self._update_queues.info(token)
            elif method == "setWebhook":
                result = await self._update_queues.set_webhook(token, fields)
            elif method == "deleteWebhook":
                result = await self._update_queues.set_webhook(token, {**fields, "url": ""})
            body = {"ok": True, "result": result}
        except (ApiRefusal, UpdateError) as error:
            status = error.status
            body = {
                "ok": False,
                "error_code": status,
                "description": error.description if isinstance(error, ApiRefusal) else str(error),
            }
            if isinstance(error, ApiRefusal) and error.parameters:
                body["parameters"] = error.parameters
        except web.HTTPRequestEntityTooLarge:
            status = 413
            body = {
                "ok": False,
                "error_code": status,
                "description": "Request exceeds the fixture byte limit",
            }
        except (ValueError, TypeError, KeyError, UnicodeError):
            status = 400
            body = {"ok": False, "error_code": 400, "description": "Bad Request: malformed request"}
        self.requests.append(
            {"method": method, "fields": sorted(fields), "files": sorted(uploads), "status": status}
        )
        del self.requests[: -self.max_history]
        known_fields = {
            name
            for definition in CONTRACT["methods"].values()
            for name in definition["parameters"] or []
        }
        known_fields.update(
            {
                "method",
                "reply_parameters",
                "disable_notification",
                "protect_content",
                "has_spoiler",
                "message_thread_id",
            }
        )
        entry = {
            "method": method if method in CONTRACT["methods"] else "<unknown>",
            "fields": sorted({name if name in known_fields else "<unknown>" for name in fields}),
            "files": sorted(
                {
                    name
                    if name in {"photo", "video", "document", "audio", "voice", "thumbnail"}
                    else "<attachment>"
                    for name in uploads
                }
            ),
            "status": status,
        }
        if status == 200 and method == "getUpdates":
            entry["update_ids"] = [item["update_id"] for item in body["result"]]
        self._record(entry)
        return web.json_response(body, status=status)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "verdict":
        parser = argparse.ArgumentParser(
            description="Fail CI on refused requests or missing replies"
        )
        parser.add_argument("journal")
        parser.add_argument("--require-response", action="store_true")
        parser.add_argument("--require-method", action="append", default=[])
        parser.add_argument("--allow-refusal", action="append", default=[])
        args = parser.parse_args(sys.argv[2:])
        try:
            result = verdict(
                args.journal,
                require_response=args.require_response,
                require_methods=args.require_method,
                allowed_refusals=args.allow_refusal,
            )
        except (OSError, UnicodeError):
            result = {"ok": False, "error": "Journal is missing or unreadable"}
        print(json.dumps(result))
        raise SystemExit(0 if result["ok"] else 1)
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--disable-video-uploads", action="store_true")
    parser.add_argument("--legacy-single-attach", action="store_true")
    parser.add_argument("--journal", type=Path)
    parser.add_argument("--enable-control", action="store_true")
    parser.add_argument("--allow-insecure-loopback-webhooks", action="store_true")
    parser.add_argument("--methods", action="store_true")
    args = parser.parse_args()
    if args.methods:
        print(
            json.dumps(
                {
                    "modeled": sorted(MODELED_METHODS),
                    "unmodeled_implemented": sorted(
                        name
                        for name, definition in CONTRACT["methods"].items()
                        if definition["implemented"] and name not in MODELED_METHODS
                    ),
                }
            )
        )
        return
    emulator = LoBotApiEmulator(
        video_uploads=not args.disable_video_uploads,
        single_attach=not args.legacy_single_attach,
        journal=args.journal,
        enable_control=args.enable_control,
        allow_insecure_loopback_webhooks=args.allow_insecure_loopback_webhooks,
    )
    web.run_app(emulator.app(), host=args.host, port=args.port, access_log=None)
