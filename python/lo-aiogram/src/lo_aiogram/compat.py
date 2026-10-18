"""Explicit, lossy adaptation for existing Telegram handlers. Never enabled on import."""

import asyncio
import json
import logging
from importlib.resources import files
from weakref import WeakSet

from aiogram.client.default import Default
from aiogram.client.session.middlewares.base import BaseRequestMiddleware
from aiogram.exceptions import TelegramBadRequest, TelegramRetryAfter, TelegramServerError
from aiogram.methods import SendDocument, SendMediaGroup, SendPhoto, SendVideo
from aiogram.types import BufferedInputFile, FSInputFile, InputFile

from lo_aiogram import LoAiohttpSession

CONTRACT = json.loads(files("lo_aiogram").joinpath("contract.json").read_text())
logger = logging.getLogger(__name__)

__all__ = ["LoBotCompat", "PartialDeliveryError"]


class PartialDeliveryError(Exception):
    """Some album parts were sent. Never automatically repeat the original album."""

    def __init__(self, completed):
        super().__init__("LO album partially delivered; inspect completed before retrying")
        self.completed = tuple(completed)


def _replayable(value):
    if isinstance(value, InputFile):
        return isinstance(value, (BufferedInputFile, FSInputFile))
    if hasattr(value, "model_dump"):
        return _replayable(value.model_dump(warnings=False))
    if isinstance(value, dict):
        return all(_replayable(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return all(_replayable(item) for item in value)
    return True


class LoBotCompat(BaseRequestMiddleware):
    """Register explicitly on a LoAiohttpSession; the strict session stays strict."""

    def __init__(self):
        self._warned = set()
        self._silent_sessions: WeakSet = WeakSet()

    def _notice(self, method, field):
        key = (method, field)
        if key not in self._warned:
            self._warned.add(key)
            # Names come from the manifest/model, never from request values or credentials.
            logger.warning("LO compat adaptation: %s.%s", method, field)

    def _adapt(self, bot, method):
        name = method.__api_method__
        definition = CONTRACT["methods"].get(name)
        if not definition or not definition["implemented"]:
            return method
        allowed = definition["parameters"]
        if allowed is None or definition.get("allowUnknownParameters"):
            return method
        changes: dict[str, object] = {}
        for key in method.model_dump(warnings=False):
            value = getattr(method, key, None)
            if key not in allowed and value is not None:
                changes[key] = None
                if not isinstance(value, Default) or getattr(bot.default, value.name) is not None:
                    self._notice(name, key if key in type(method).model_fields else "extra_field")
        media = getattr(method, name[4:].lower(), None) if name.startswith("send") else None
        if isinstance(media, str) and not media.startswith("attach://"):
            for key in definition.get("uploadOnly", []):
                if getattr(method, key, None) is not None:
                    changes[key] = None
                    self._notice(name, key)
        return method.model_copy(update=changes)

    async def _attempt(self, make_request, bot, method):
        try:
            return await make_request(bot, method)
        except TelegramRetryAfter as error:
            if (
                getattr(error, "lo_safe_to_retry", False) is not True
                or method.__api_method__ not in CONTRACT["methods"]
                or not 0 <= error.retry_after <= 60
                or not _replayable(method)
            ):
                raise
            self._notice(method.__api_method__, "safe_refusal_retry")
            await asyncio.sleep(error.retry_after)
            return await make_request(bot, method)

    async def _send(self, make_request, bot, method):
        if method.__api_method__ == "sendChatAction" and bot.session in self._silent_sessions:
            return True
        method = self._adapt(bot, method)
        try:
            return await self._attempt(make_request, bot, method)
        except TelegramBadRequest as error:
            if (
                isinstance(method, SendVideo)
                and isinstance(method.video, (BufferedInputFile, FSInputFile))
                and getattr(error, "lo_reason", None) == "feature_disabled"
                and getattr(error, "lo_parameter", None) == "video"
            ):
                self._notice("sendVideo", "document_fallback")
                data = {
                    key: getattr(method, key)
                    for key in CONTRACT["methods"]["sendDocument"]["parameters"]
                    if hasattr(method, key)
                }
                data["document"] = method.video
                return await self._attempt(make_request, bot, SendDocument(**data))
            raise
        except TelegramServerError as error:
            if (
                method.__api_method__ == "sendChatAction"
                and getattr(error, "lo_status", None) == 501
                and getattr(error, "lo_reason", None) == "method_not_implemented"
            ):
                self._notice("sendChatAction", "local_noop")
                self._silent_sessions.add(bot.session)
                return True
            raise

    def _album_parts(self, method):
        items = method.media
        if (
            not CONTRACT["inputMedia"]["minItems"]
            <= len(items)
            <= CONTRACT["inputMedia"]["maxItems"]
        ):
            raise ValueError("LO compat albums require 2 to 10 items")
        if any(item.type not in (*CONTRACT["inputMedia"]["types"], "video") for item in items):
            raise ValueError("LO compat albums support photo, document and video only")
        groups: list[list] = []
        for item in items:
            if (
                groups
                and item.type != "video"
                and groups[-1][-1].type == item.type
                and not item.caption
            ):
                groups[-1].append(item)
            else:
                groups.append([item])
        parts = []
        for group in groups:
            if len(group) > 1:
                clean = []
                for item in group:
                    changes: dict[str, object] = {}
                    for key in item.model_dump(warnings=False):
                        if key not in CONTRACT["inputMedia"]["parameters"]:
                            changes[key] = None
                            if getattr(item, key, None) is not None:
                                self._notice(
                                    "sendMediaGroup",
                                    key if key in type(item).model_fields else "extra_field",
                                )
                    clean.append(item.model_copy(update=changes))
                parts.append(SendMediaGroup(chat_id=method.chat_id, media=clean))
            else:
                item = group[0]
                constructor = {"photo": SendPhoto, "video": SendVideo, "document": SendDocument}[
                    item.type
                ]
                allowed = CONTRACT["methods"]["send" + item.type.capitalize()]["parameters"]
                for key in item.model_dump(warnings=False):
                    if (
                        key not in (*allowed, "type", "media")
                        and getattr(item, key, None) is not None
                    ):
                        self._notice(
                            "sendMediaGroup",
                            key if key in type(item).model_fields else "extra_field",
                        )
                data = {key: getattr(item, key) for key in allowed if hasattr(item, key)}
                data.update(chat_id=method.chat_id, **{item.type: item.media})
                parts.append(constructor(**data))
        return parts

    async def __call__(self, make_request, bot, method):
        if not isinstance(bot.session, LoAiohttpSession):
            raise ValueError("LO compatibility requires LoAiohttpSession")
        if any(
            getattr(method, key, None) is not None
            for key in (
                "business_connection_id",
                "lo_context",
                "lo_request_id",
                "lo_quote",
                "lo_media",
                "lo_delete_all",
            )
        ):
            raise ValueError("LO secretary operations require native consent context")
        if isinstance(method, SendMediaGroup):
            method = self._adapt(bot, method)
            parts = self._album_parts(method)
            if len(parts) > 1:
                self._notice("sendMediaGroup", "sequential_parts")
            completed: list = []
            for part in parts:
                try:
                    result = await self._send(make_request, bot, part)
                except asyncio.CancelledError as error:
                    error.__dict__["completed"] = tuple(completed)
                    raise
                except Exception as error:
                    if completed:
                        raise PartialDeliveryError(completed) from error
                    raise
                completed.extend(result if isinstance(result, list) else [result])
            return completed
        return await self._send(make_request, bot, method)
