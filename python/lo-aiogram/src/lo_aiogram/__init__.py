"""LO HTTP serialization for aiogram, without automatic request adaptation."""

import json
from urllib.parse import urlsplit

from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.exceptions import TelegramBadRequest, TelegramNetworkError, TelegramServerError
from aiogram.types import InputFile
from aiohttp import ClientError, ClientTimeout, FormData

__all__ = ["LoAiohttpSession"]


class LoAiohttpSession(AiohttpSession):
    """Send the requested operation once, with parameter-named upload parts."""

    def __init__(self, *, base_url="https://api.lo.ink", allow_insecure_loopback=False, **kwargs):
        parsed = urlsplit(base_url)
        if (
            not parsed.hostname
            or base_url.strip() != base_url
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
            or parsed.scheme != "https"
            and not (
                allow_insecure_loopback
                and parsed.scheme == "http"
                and parsed.hostname in ("localhost", "127.0.0.1", "::1")
            )
        ):
            raise ValueError("Use HTTPS or explicitly enabled loopback HTTP")
        super().__init__(api=TelegramAPIServer.from_base(base_url.rstrip("/")), **kwargs)

    async def make_request(self, bot, method, timeout=None):
        session = await self.create_session()
        url = self.api.api_url(token=bot.token, method=method.__api_method__)
        form = self.build_form_data(bot=bot, method=method)
        try:
            async with session.post(
                url,
                data=form,
                timeout=ClientTimeout(total=self.timeout if timeout is None else timeout),
                allow_redirects=False,
            ) as response:
                if 300 <= response.status < 400:
                    raise TelegramNetworkError(
                        method=method, message="LO Bot API redirects are not allowed"
                    )
                content = await response.text()
                status = response.status
        except TimeoutError:
            raise TelegramNetworkError(
                method=method, message="LO Bot API request timed out"
            ) from None
        except ClientError:
            raise TelegramNetworkError(method=method, message="LO Bot API request failed") from None
        return self.check_response(bot, method, status, content).result

    async def stream_content(
        self, url, headers=None, timeout=30, chunk_size=65536, raise_for_status=True
    ):
        session = await self.create_session()
        try:
            async with session.get(
                url,
                headers=headers,
                timeout=timeout,
                allow_redirects=False,
                raise_for_status=False,
            ) as response:
                if 300 <= response.status < 400:
                    raise ClientError("LO file redirects are not allowed")
                if raise_for_status:
                    response.raise_for_status()
                async for chunk in response.content.iter_chunked(chunk_size):
                    yield chunk
        except TimeoutError:
            raise TimeoutError("LO file download timed out") from None
        except ClientError:
            raise ClientError("LO file download failed") from None

    def build_form_data(self, bot, method):
        if getattr(method, "business_connection_id", None) is not None:
            raise ValueError("LO secretary operations require native consent context")
        form = FormData(quote_fields=False)
        attachments: dict[str, InputFile] = {}
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
        try:
            if status_code >= 500:
                raise TelegramServerError(
                    method=method, message="LO Bot API is temporarily unavailable"
                )
            return super().check_response(bot, method, status_code, content)
        except (TelegramBadRequest, TelegramServerError) as error:
            try:
                parameters = json.loads(content).get("parameters", {})
            except (ValueError, TypeError, AttributeError):
                parameters = {}
            if isinstance(parameters, dict):
                metadata = {}
                reason = parameters.get("reason")
                parameter = parameters.get("parameter")
                if reason in (
                    "unsupported_parameter",
                    "upload_only",
                    "feature_disabled",
                    "method_not_implemented",
                ):
                    metadata["lo_reason"] = reason
                if isinstance(parameter, str) and parameter.isidentifier():
                    metadata["lo_parameter"] = parameter
                for attribute, value in metadata.items():
                    setattr(error, attribute, value)
            raise
