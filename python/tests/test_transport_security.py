import asyncio
import json
import traceback
import unittest
from unittest.mock import AsyncMock

from aiogram import Bot
from aiogram.exceptions import TelegramNetworkError, TelegramServerError
from aiogram.methods import SendMessage
from aiohttp import ClientError, web
from lo_aiogram import LoAiohttpSession

TOKEN = "123456:" + "A" * 43


class TransportSecurity(unittest.IsolatedAsyncioTestCase):
    async def server(self, handler):
        app = web.Application()
        app.router.add_route("*", "/{path:.*}", handler)
        runner = web.AppRunner(app)
        await runner.setup()
        self.addAsyncCleanup(runner.cleanup)
        await web.TCPSite(runner, "127.0.0.1", 0).start()
        return f"http://127.0.0.1:{runner.addresses[0][1]}"

    def session(self, base):
        session = LoAiohttpSession(base_url=base, allow_insecure_loopback=True)
        self.addAsyncCleanup(session.close)
        return session

    def assert_safe(self, error):
        for text in (str(error), repr(error), "".join(traceback.format_exception(error))):
            self.assertNotIn(TOKEN, text)
            self.assertNotIn("private-marker", text)
        self.assertIsNone(error.__cause__)

    async def test_api_and_file_redirects_are_refused_without_forwarding(self):
        forwarded = []

        async def destination(request):
            forwarded.append(request.path)
            return web.Response(body=b"private-marker")

        target = await self.server(destination)
        for status in (301, 302, 303, 307, 308):
            for same_origin in (False, True):
                calls = []

                async def redirect(request, calls=calls, same_origin=same_origin, status=status):
                    calls.append(request.path)
                    location = str(request.url) if same_origin else target + "/private-marker"
                    return web.Response(
                        status=status,
                        headers={"Location": location},
                        text=json.dumps({"ok": True, "result": "private-marker"}),
                    )

                base = await self.server(redirect)
                session = self.session(base)
                bot = Bot(TOKEN, session=session)
                with self.subTest(status=status, same_origin=same_origin, kind="api"):
                    with self.assertRaises(TelegramNetworkError) as caught:
                        await bot.send_message(7, "Synthetic message")
                    self.assert_safe(caught.exception)
                with self.subTest(status=status, same_origin=same_origin, kind="file"):
                    with self.assertRaises(ClientError) as caught:
                        async for _ in session.stream_content(base + "/file/bot" + TOKEN):
                            self.fail("Redirect body was consumed")
                    self.assert_safe(caught.exception)
                self.assertEqual(len(calls), 2)
                self.assertEqual(forwarded, [])

    async def test_file_status_errors_hide_authenticated_urls(self):
        async def missing(_request):
            return web.Response(status=404, text="private-marker")

        base = await self.server(missing)
        session = self.session(base)
        with self.assertRaises(ClientError) as caught:
            async for _ in session.stream_content(base + "/file/bot" + TOKEN):
                self.fail("Error body was consumed")
        self.assert_safe(caught.exception)
        chunks = [
            chunk
            async for chunk in session.stream_content(
                base + "/file/bot" + TOKEN, raise_for_status=False, chunk_size=2
            )
        ]
        self.assertEqual(b"".join(chunks), b"private-marker")
        self.assertTrue(all(len(chunk) <= 2 for chunk in chunks))

    async def test_api_network_failure_suppresses_original_traceback(self):
        session = self.session("http://127.0.0.1")
        client = unittest.mock.MagicMock()
        client.post.return_value.__aenter__.side_effect = ClientError(TOKEN + " private-marker")
        session.create_session = AsyncMock(return_value=client)
        with self.assertRaises(TelegramNetworkError) as caught:
            await Bot(TOKEN, session=session).send_message(7, "Synthetic message")
        self.assert_safe(caught.exception)
        self.assertEqual(client.post.call_count, 1)

    async def test_explicit_timeout_and_cancellation_are_preserved(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def wait(_request):
            started.set()
            await release.wait()
            return web.Response(text="private-marker")

        base = await self.server(wait)
        session = self.session(base)
        bot = Bot(TOKEN, session=session)
        method = SendMessage(chat_id=7, text="Synthetic message")
        try:
            with self.assertRaises(TelegramNetworkError) as caught:
                await session.make_request(bot, method, timeout=0.01)
            self.assert_safe(caught.exception)
            started.clear()
            task = asyncio.create_task(session.make_request(bot, method))
            await asyncio.wait_for(started.wait(), timeout=2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        finally:
            release.set()

    async def test_all_5xx_shapes_have_safe_server_errors_and_refusal_metadata(self):
        session = self.session("http://127.0.0.1")
        bot = Bot(TOKEN, session=session)
        method = SendMessage(chat_id=7, text="Synthetic message")
        contents = ["", "<html>private-marker</html>", "null", "[]"]
        contents.extend(
            json.dumps(value)
            for value in [
                {"ok": False, "error_code": 503},
                {"ok": True, "result": True},
                *({"ok": False, "description": value} for value in (None, 4, "", "private-marker")),
                {"ok": False, "description": "private-marker", "parameters": "bad"},
                {
                    "ok": False,
                    "error_code": [],
                    "parameters": {
                        "reason": "method_not_implemented",
                        "parameter": "sendChatAction",
                    },
                },
            ]
        )
        for content in contents:
            with self.subTest(content_type=type(content).__name__):
                with self.assertRaises(TelegramServerError) as caught:
                    session.check_response(bot, method, 503, content)
                self.assert_safe(caught.exception)
        with self.assertRaises(TelegramServerError) as caught:
            session.check_response(
                bot,
                method,
                501,
                json.dumps(
                    {
                        "ok": False,
                        "error_code": 501,
                        "description": "private-marker",
                        "parameters": {
                            "reason": "method_not_implemented",
                            "parameter": "sendChatAction",
                        },
                    }
                ),
            )
        self.assertEqual(caught.exception.lo_reason, "method_not_implemented")
        self.assertEqual(caught.exception.lo_parameter, "sendChatAction")

    async def test_error_response_boundaries_redact_credentials_without_changing_success(self):
        from urllib.parse import quote

        from aiogram.exceptions import (
            ClientDecodeError,
            TelegramBadRequest,
            TelegramMigrateToChat,
            TelegramRetryAfter,
        )

        encoded = quote(TOKEN, safe="")
        cases = [
            (
                400,
                {"ok": False, "error_code": 400, "description": f"request /bot{TOKEN}/sendMessage"},
                TelegramBadRequest,
            ),
            (
                429,
                {
                    "ok": False,
                    "error_code": 429,
                    "description": f"request {encoded.lower()}",
                    "parameters": {"retry_after": 12},
                },
                TelegramRetryAfter,
            ),
            (
                400,
                {
                    "ok": False,
                    "error_code": 400,
                    "description": TOKEN,
                    "parameters": {"migrate_to_chat_id": -123},
                },
                TelegramMigrateToChat,
            ),
            (200, "private-marker " + TOKEN, ClientDecodeError),
            (200, b"\xffprivate-marker " + TOKEN.encode(), ClientDecodeError),
            (503, b"\xffprivate-marker " + TOKEN.encode(), TelegramServerError),
            (
                200,
                {"ok": True, "result": {"text": TOKEN, "private": "private-marker"}},
                ClientDecodeError,
            ),
        ]
        for status, payload, expected in cases:

            async def response(request, status=status, payload=payload):
                if isinstance(payload, bytes):
                    return web.Response(status=status, body=payload)
                if isinstance(payload, str):
                    return web.Response(status=status, text=payload)
                return web.json_response(payload, status=status)

            session = self.session(await self.server(response))
            bot = Bot(TOKEN, session=session)
            with self.assertRaises(expected) as caught:
                await session.make_request(bot, SendMessage(chat_id=42, text="test"))
            error = caught.exception
            for output in (str(error), repr(error), "".join(traceback.format_exception(error))):
                self.assertNotIn(TOKEN, output)
                self.assertNotIn(encoded.lower(), output.lower())
            self.assertIsNone(error.__cause__)
            if expected is ClientDecodeError:
                self.assert_safe(error)
            elif expected is TelegramRetryAfter:
                self.assertEqual(error.retry_after, 12)
            elif expected is TelegramMigrateToChat:
                self.assertEqual(error.migrate_to_chat_id, -123)

        session = self.session("http://127.0.0.1:1")
        bot = Bot(TOKEN, session=session)
        result = session.check_response(
            bot,
            SendMessage(chat_id=42, text="test"),
            200,
            json.dumps(
                {
                    "ok": True,
                    "result": {
                        "message_id": 1,
                        "date": 1800000000,
                        "chat": {"id": 42, "type": "private"},
                        "text": TOKEN,
                    },
                }
            ),
        ).result
        self.assertEqual(result.text, TOKEN)
