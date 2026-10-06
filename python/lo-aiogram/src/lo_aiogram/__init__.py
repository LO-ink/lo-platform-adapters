"""aiogram compatibility belongs in this adapter, outside the native LO SDK."""
import asyncio
import hashlib
import json
import logging
import math
import time
from urllib.parse import urlsplit

from aiohttp import FormData
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.default import Default
from aiogram.client.telegram import TelegramAPIServer
from aiogram.exceptions import TelegramBadRequest, TelegramRetryAfter, TelegramServerError
from aiogram.methods import GetMe, SendDocument, SendMediaGroup, SendPhoto, SendVideo
from aiogram.types import InputFile, InputMediaDocument, InputMediaPhoto
from importlib.resources import files

CONTRACT = json.loads(files(__package__).joinpath("contract.json").read_text())

__all__ = ["LoAiohttpSession", "LoBotApiCompat"]
log = logging.getLogger("lo_aiogram")


class LoAiohttpSession(AiohttpSession):
    """Names single-upload parts by their parameter, including legacy installations."""
    def __init__(self, *, base_url="https://api.lo.ink", allow_insecure_loopback=False, compatibility=True, **kwargs):
        parsed = urlsplit(base_url)
        if not parsed.hostname or base_url.strip() != base_url or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.scheme != "https" and not (allow_insecure_loopback and parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")):
            raise ValueError("Use HTTPS or explicitly enabled loopback HTTP")
        super().__init__(api=TelegramAPIServer.from_base(base_url.rstrip("/")), **kwargs)
        if compatibility:
            self.middleware(LoBotApiCompat())

    def build_form_data(self, bot, method):
        form = FormData(quote_fields=False)
        attachments = {}
        for key, original in method.model_dump(warnings=False).items():
            original = getattr(method, key, original)
            if isinstance(original, InputFile):
                form.add_field(key, original.read(bot), filename=original.filename or key)
            else:
                value = self.prepare_value(original, bot=bot, files=attachments)
                if value is not None and value != "":
                    form.add_field(key, value)
        for key, value in attachments.items():
            form.add_field(key, value.read(bot), filename=value.filename or key)
        return form

    def check_response(self, bot, method, status_code, content):
        if status_code >= 500:
            try:
                parsed = json.loads(content)
            except (ValueError, TypeError):
                parsed = None
            if not isinstance(parsed, dict) or not isinstance(parsed.get("ok"), bool):
                raise TelegramServerError(method=method, message="LO Bot API is temporarily unavailable")
        try:
            return super().check_response(bot, method, status_code, content)
        except (TelegramBadRequest, TelegramServerError) as error:
            try:
                parameters = json.loads(content).get("parameters", {})
            except (ValueError, TypeError, AttributeError):
                parameters = {}
            if isinstance(parameters, dict):
                reason = parameters.get("reason")
                parameter = parameters.get("parameter")
                if reason in ("unsupported_parameter", "upload_only", "feature_disabled", "method_not_implemented"):
                    error.lo_reason = reason
                if isinstance(parameter, str) and parameter.isidentifier():
                    error.lo_parameter = parameter
            raise


class LoBotApiCompat:
    def __init__(self, *, feature_ttl=300, max_video_retry_after=30, capability_refresh_interval=300, probe_capabilities=True, sleep=asyncio.sleep, clock=time.monotonic):
        if not math.isfinite(feature_ttl) or feature_ttl <= 0 or not math.isfinite(max_video_retry_after) or not 0 <= max_video_retry_after <= 300:
            raise ValueError("Invalid feature cache or retry limit")
        if not math.isfinite(capability_refresh_interval) or capability_refresh_interval <= 0:
            raise ValueError("Invalid capability refresh interval")
        self.capability_refresh_interval, self.probe_capabilities = capability_refresh_interval, probe_capabilities
        self.next_capability_check = {}
        self.feature_ttl, self.max_video_retry_after = feature_ttl, max_video_retry_after
        self.sleep, self.clock = sleep, clock
        self.video_disabled, self.chat_action_disabled, self.unsupported, self.warned = {}, set(), {}, set()

    def scope(self, bot):
        # Separate credentials for the same bot generation, without retaining raw tokens.
        return hashlib.sha256((bot.session.api.base + "\0" + bot.token).encode()).hexdigest()

    def reset(self, bot):
        """Discard learned installation limits after an operator changes the server."""
        scope = self.scope(bot)
        self.video_disabled.pop(scope, None)
        self.next_capability_check.pop(scope, None)
        self.chat_action_disabled.discard(scope)
        self.unsupported = {key: value for key, value in self.unsupported.items() if key[0] != scope}
        self.warned = {key for key in self.warned if key[0] != scope}

    def remember_capabilities(self, scope, identity):
        self.next_capability_check[scope] = self.clock() + self.capability_refresh_interval
        capabilities = getattr(identity, "capabilities", None)
        if isinstance(capabilities, dict):
            enabled = capabilities.get("video_uploads")
            if enabled is True:
                self.video_disabled.pop(scope, None)
            elif enabled is False:
                self.video_disabled[scope] = self.clock() + self.capability_refresh_interval

    def warn(self, scope, method, field):
        key = (scope, method, field)
        if key not in self.warned:
            self.warned.add(key)
            log.warning("LO omitted unsupported parameter %s.%s", method, field)

    def filtered(self, bot, method):
        scope, name = self.scope(bot), method.__api_method__
        definition = CONTRACT["methods"].get(name)
        values = method.model_dump(warnings=False)
        if getattr(method, "business_connection_id", None) is not None:
            raise ValueError("LO secretary operations require the native SDK; the compatibility adapter cannot supply consent context")
        allowed = definition.get("parameters") if definition else None
        omitted = set(self.unsupported.get((scope, name), ()))
        if allowed is not None and definition["implemented"] and not definition.get("allowUnknownParameters"):
            omitted.update(key for key in values if key not in allowed and getattr(method, key, None) is not None)
        if name == "sendVideo" and not isinstance(method.video, InputFile):
            omitted.update(definition["uploadOnly"])
        updates = {}
        for key in omitted:
            value = getattr(method, key, None)
            if isinstance(value, Default):
                value = bot.default[value.name]
            if value is not None:
                self.warn(scope, name, key)
            updates[key] = None
        if name == "sendMediaGroup":
            media = []
            for index, item in enumerate(method.media):
                item_omitted = {key: None for key in item.model_dump() if key not in CONTRACT["inputMedia"]["parameters"]}
                if index > 0:
                    item_omitted.update(caption=None, parse_mode=None, caption_entities=None)
                media.append(item.model_copy(update=item_omitted))
            updates["media"] = media
        return method.model_copy(update=updates)

    @staticmethod
    def has_files(method):
        def visit(value):
            if isinstance(value, InputFile):
                return True
            if isinstance(value, dict):
                return any(visit(item) for item in value.values())
            if isinstance(value, (list, tuple)):
                return any(visit(item) for item in value)
            if hasattr(type(value), "model_fields"):
                return any(visit(getattr(value, key, None)) for key in type(value).model_fields)
            return False
        return visit(method)

    @staticmethod
    def video_document(method):
        return SendDocument(chat_id=method.chat_id, document=method.video, caption=method.caption, parse_mode=method.parse_mode, caption_entities=method.caption_entities, reply_markup=method.reply_markup)

    async def send_video(self, make_request, bot, method, scope):
        uploaded = isinstance(method.video, InputFile)
        if uploaded and self.video_disabled.get(scope, 0) > self.clock():
            return await make_request(bot, self.filtered(bot, self.video_document(method)))
        try:
            return await make_request(bot, method)
        except TelegramBadRequest as error:
            if uploaded and (getattr(error, "lo_reason", None) == "feature_disabled" and getattr(error, "lo_parameter", None) == "video" or error.message == "Bad Request: video must be a file identifier"):
                self.video_disabled[scope] = self.clock() + self.feature_ttl
                return await make_request(bot, self.filtered(bot, self.video_document(method)))
            raise
        except TelegramRetryAfter as error:
            if not uploaded or not 0 <= error.retry_after <= self.max_video_retry_after:
                raise
            await self.sleep(error.retry_after)
            try:
                return await make_request(bot, method)
            except TelegramRetryAfter:
                return await make_request(bot, self.filtered(bot, self.video_document(method)))

    async def split_album(self, make_request, bot, method, scope):
        result = []
        pending = []
        async def flush():
            if not pending:
                return
            if len(pending) > 1:
                normalized = [item.model_copy(update={"caption": None, "parse_mode": None, "caption_entities": None}) if index else item for index, item in enumerate(pending)]
                response = await make_request(bot, SendMediaGroup(chat_id=method.chat_id, media=normalized))
                result.extend(response)
            else:
                item = pending[0]
                cls = SendPhoto if item.type == "photo" else SendDocument
                field = "photo" if item.type == "photo" else "document"
                response = await make_request(bot, cls(chat_id=method.chat_id, **{field: item.media}, caption=item.caption, parse_mode=item.parse_mode, caption_entities=item.caption_entities))
                result.append(response)
            pending.clear()
        for item in method.media:
            if item.type == "video":
                await flush()
                result.append(await self.send_video(make_request, bot, self.filtered(bot, SendVideo(chat_id=method.chat_id, video=item.media, caption=item.caption, parse_mode=item.parse_mode, caption_entities=item.caption_entities, duration=item.duration, width=item.width, height=item.height, thumbnail=item.thumbnail, supports_streaming=item.supports_streaming)), scope))
            else:
                cls = InputMediaPhoto if item.type == "photo" else InputMediaDocument
                converted = cls(media=item.media, caption=item.caption, parse_mode=item.parse_mode, caption_entities=item.caption_entities)
                if pending and pending[0].type != converted.type:
                    await flush()
                pending.append(converted)
        await flush()
        return result

    async def __call__(self, make_request, bot, method):
        scope, name = self.scope(bot), method.__api_method__
        original = method
        method = self.filtered(bot, method)
        if name == "getMe":
            identity = await make_request(bot, method)
            self.remember_capabilities(scope, identity)
            return identity
        if name == "sendVideo" and self.probe_capabilities and self.next_capability_check.get(scope, 0) <= self.clock():
            self.remember_capabilities(scope, await make_request(bot, GetMe()))
        if name == "sendChatAction" and scope in self.chat_action_disabled:
            return True
        try:
            if name == "sendVideo":
                return await self.send_video(make_request, bot, method, scope)
            return await make_request(bot, method)
        except TelegramServerError as error:
            if name == "sendChatAction" and (getattr(error, "lo_reason", None) == "method_not_implemented" or error.message == "Method not implemented: sendChatAction"):
                self.chat_action_disabled.add(scope)
                self.warn(scope, name, "action")
                return True
            raise
        except TelegramBadRequest as error:
            if name == "sendMediaGroup" and all(item.type in ("photo", "document", "video") for item in original.media) and error.message in ("Bad Request: media type video is not supported yet", "Bad Request: a media group must contain items of one type"):
                return await self.split_album(make_request, bot, original, scope)
            # Retry one field refusal only when no file producer would be replayed.
            prefix, suffix = "Bad Request: ", " is not supported yet"
            field = getattr(error, "lo_parameter", None) if getattr(error, "lo_reason", None) == "unsupported_parameter" else None
            if field is None and error.message.startswith(prefix) and error.message.endswith(suffix):
                field = error.message[len(prefix):-len(suffix)]
            if not self.has_files(method) and isinstance(field, str):
                if field.isidentifier() and field in type(method).model_fields and getattr(method, field, None) is not None:
                    self.unsupported.setdefault((scope, name), set()).add(field)
                    self.warn(scope, name, field)
                    return await make_request(bot, method.model_copy(update={field: None}))
            raise
