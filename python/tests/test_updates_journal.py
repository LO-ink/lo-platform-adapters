import asyncio
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.exceptions import TelegramBadRequest, TelegramConflictError
from aiogram.filters import CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup
from aiohttp import ClientSession, web
from lo_aiogram.compat import LoBotCompat
from lo_bot_api_emulator import CONTRACT, MODELED_METHODS, LoBotApiEmulator
from lo_bot_api_emulator.journal import verdict
from lo_bot_api_emulator.updates import UpdateError
from test_conformance import TOKEN, Fixture

USER = {"id": 42, "is_bot": False, "first_name": ""}
MESSAGE = {
    "message_id": 10,
    "date": 1,
    "chat": {"id": 42, "type": "private"},
    "from": USER,
    "text": "/start",
}


class Updates(Fixture):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.journal = Path(directory.name) / "requests.jsonl"
        self.emulator = LoBotApiEmulator(
            journal=self.journal, enable_control=True, allow_insecure_loopback_webhooks=True
        )
        self.runner = web.AppRunner(self.emulator.app(), access_log=None)
        await self.runner.setup()
        self.addAsyncCleanup(self.runner.cleanup)
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.base = f"http://127.0.0.1:{self.runner.addresses[0][1]}"
        self.bot = self.new_bot()

    async def test_empty_poll_waits_and_enqueue_wakes_it(self):
        start = time.monotonic()
        self.assertEqual(await self.bot.get_updates(timeout=1), [])
        self.assertGreaterEqual(time.monotonic() - start, 0.85)
        poll = asyncio.create_task(self.bot.get_updates(timeout=1))
        await asyncio.sleep(0.05)
        identity = await self.emulator.enqueue_update({"message": MESSAGE}, token=TOKEN)
        result = await asyncio.wait_for(poll, 0.5)
        self.assertEqual(result[0].update_id, identity)
        self.assertEqual(result[0].message.text, "/start")

    async def test_offsets_acknowledge_only_this_bot_and_return_copies(self):
        await self.emulator.enqueue_update({"message": MESSAGE}, token=TOKEN)
        await self.emulator.enqueue_update({"message": {**MESSAGE, "text": "second"}}, token=TOKEN)
        first = await self.bot.get_updates(limit=1)
        self.assertEqual(first[0].message.text, "/start")
        self.assertEqual((await self.bot.get_updates())[0].update_id, first[0].update_id)
        self.assertEqual(len(await self.bot.get_updates(offset=first[0].update_id + 1)), 1)
        other = Bot("999:" + "B" * 43, session=self.bot.session)
        self.assertEqual(await other.get_updates(), [])
        self.assertEqual(len(await self.bot.get_updates(offset=-1)), 1)
        with self.assertRaises(TelegramBadRequest):
            await self.bot.get_updates(limit=101)

    async def test_concurrent_polls_conflict_without_changing_first_filter(self):
        first = asyncio.create_task(self.bot.get_updates(timeout=1, allowed_updates=["message"]))
        await asyncio.sleep(0.05)
        with self.assertRaises(TelegramConflictError):
            await self.bot.get_updates(allowed_updates=["inline_query"])
        await self.emulator.enqueue_update(
            {"inline_query": {"id": "q", "from": USER, "query": "", "offset": ""}}, token=TOKEN
        )
        self.assertFalse(first.done())
        await self.emulator.enqueue_update({"message": MESSAGE}, token=TOKEN)
        result = await asyncio.wait_for(first, 0.5)
        self.assertIsNotNone(result[0].message)
        self.assertIsNone(result[0].inline_query)

    async def test_cancelled_poll_releases_its_ownership(self):
        first = asyncio.create_task(self.emulator._update_queues.poll(TOKEN, {"timeout": 1}))
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.assertEqual(await self.emulator._update_queues.poll(TOKEN, {}), [])

    async def test_cancelled_http_poll_releases_ownership_before_original_timeout(self):
        first = asyncio.create_task(self.bot.get_updates(timeout=2))
        await asyncio.sleep(0.05)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        await asyncio.sleep(0.2)
        self.assertEqual(await self.bot.get_updates(), [])
        identity = await self.emulator.enqueue_update({"message": MESSAGE}, token=TOKEN)
        self.assertEqual((await self.bot.get_updates())[0].update_id, identity)

    async def test_empty_url_webhook_removal_works_through_aiogram(self):
        await self.bot.set_webhook("https://example.invalid/hook")
        self.assertTrue(await self.bot.set_webhook(""))
        self.assertEqual((await self.bot.get_webhook_info()).url, "")
        self.assertEqual(await self.bot.get_updates(), [])

    async def test_unknown_update_filters_refused_without_changing_existing_filter(self):
        await self.bot.get_updates(allowed_updates=["message"])
        with self.assertRaises(TelegramBadRequest):
            await self.bot.get_updates(allowed_updates=["messages"])
        identity = await self.emulator.enqueue_update({"message": MESSAGE}, token=TOKEN)
        self.assertEqual((await self.bot.get_updates())[0].update_id, identity)
        await self.bot.get_updates(offset=identity + 1)
        await self.bot.set_webhook("https://example.invalid/hook", allowed_updates=["poll"])
        with self.assertRaises(TelegramBadRequest):
            await self.bot.set_webhook(
                "https://example.invalid/other", allowed_updates=["messages"]
            )
        info = await self.bot.get_webhook_info()
        self.assertEqual(info.url, "https://example.invalid/hook")
        self.assertEqual(info.allowed_updates, ["poll"])
        await self.bot.delete_webhook()
        self.assertEqual(await self.bot.get_updates(allowed_updates=["chat_member"]), [])

    async def test_webhook_connection_limits_are_validated_before_state_changes(self):
        await self.bot.set_webhook("https://example.invalid/hook", max_connections=1)
        for connections in (0, 101):
            with self.subTest(connections=connections), self.assertRaises(TelegramBadRequest):
                await self.bot.set_webhook(
                    "https://example.invalid/other", max_connections=connections
                )
            self.assertEqual(
                (await self.bot.get_webhook_info()).url, "https://example.invalid/hook"
            )
        self.assertTrue(
            await self.bot.set_webhook("https://example.invalid/hook", max_connections=100)
        )

    async def test_real_polling_bot_answers_start_and_button_and_inline_without_400(self):
        self.bot.session.middleware(LoBotCompat())
        dispatcher, received = Dispatcher(), asyncio.Event()
        keyboard = InlineKeyboardMarkup(
            inline_keyboard=[[InlineKeyboardButton(text="RU", callback_data="ru")]]
        )

        @dispatcher.message(CommandStart())
        async def start(message):
            await message.reply("Choose language", disable_notification=True, reply_markup=keyboard)
            received.set()

        @dispatcher.callback_query(F.data == "ru")
        async def button(query):
            await query.message.edit_reply_markup(
                reply_markup=InlineKeyboardMarkup(inline_keyboard=[])
            )
            await query.answer()
            received.set()

        @dispatcher.inline_query()
        async def inline(query):
            await query.answer(results=[])
            received.set()

        task = asyncio.create_task(
            dispatcher.start_polling(
                self.bot, handle_signals=False, close_bot_session=False, polling_timeout=1
            )
        )
        try:
            for update in (
                {"message": MESSAGE},
                {
                    "callback_query": {
                        "id": "callback",
                        "from": {**USER, "language_code": "ru"},
                        "chat_instance": "chat",
                        "message": MESSAGE,
                        "data": "ru",
                    }
                },
                {
                    "inline_query": {
                        "id": "inline",
                        "from": {**USER, "language_code": "ru"},
                        "query": "",
                        "offset": "",
                    }
                },
            ):
                received.clear()
                async with ClientSession() as client:
                    async with client.post(
                        self.base + "/__fixture/updates", json={"token": TOKEN, "update": update}
                    ) as response:
                        self.assertEqual(response.status, 200)
                await asyncio.wait_for(received.wait(), 3)
        finally:
            await dispatcher.stop_polling()
            await asyncio.wait_for(task, 3)
        result = verdict(
            self.journal,
            require_response=True,
            require_methods=["editMessageReplyMarkup", "answerCallbackQuery", "answerInlineQuery"],
        )
        self.assertTrue(result["ok"], result)
        self.assertTrue(all(row["status"] == 200 for row in self.emulator.requests))
        process = self.cli(
            "verdict",
            str(self.journal),
            "--require-response",
            "--require-method",
            "editMessageReplyMarkup",
        )
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)

    async def test_same_handler_without_compat_fails_strictly(self):
        dispatcher = Dispatcher()

        @dispatcher.message()
        async def reply(message):
            await message.reply("Reply", disable_notification=True, protect_content=True)

        with self.assertRaises(TelegramBadRequest):
            await dispatcher.feed_raw_update(self.bot, {"update_id": 1, "message": MESSAGE})
        self.assertFalse(verdict(self.journal, require_response=True)["ok"])

    async def webhook(self, handler):
        app = web.Application()
        app.router.add_post("/hook", handler)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        self.addAsyncCleanup(runner.cleanup)
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        return f"http://127.0.0.1:{runner.addresses[0][1]}/hook"

    async def test_webhook_delivers_exact_payload_secret_and_keeps_failed_update(self):
        seen, status = [], [503]

        async def receive(request):
            seen.append(
                (await request.json(), request.headers.get("X-Telegram-Bot-Api-Secret-Token"))
            )
            return web.Response(status=status[0])

        url = await self.webhook(receive)
        await self.bot.set_webhook(url, secret_token="synthetic_secret")
        original = {"message": {**MESSAGE, "from": {"id": 42}}}
        identity = await self.emulator.enqueue_update(original, token=TOKEN)
        self.assertEqual(seen[0], ({**original, "update_id": identity}, "synthetic_secret"))
        self.assertEqual((await self.bot.get_webhook_info()).pending_update_count, 1)
        with self.assertRaises(TelegramConflictError):
            await self.bot.get_updates(offset=identity + 1)
        self.assertEqual((await self.bot.get_webhook_info()).pending_update_count, 1)
        status[0] = 200
        self.assertEqual(await self.emulator.deliver_updates(token=TOKEN), 1)
        self.assertEqual((await self.bot.get_webhook_info()).pending_update_count, 0)
        await self.bot.delete_webhook()
        self.assertEqual(await self.bot.get_updates(), [])
        self.assertEqual(len(seen), 2)

    async def test_webhook_change_wakes_poll_and_filters_updates(self):
        seen = []

        async def receive(request):
            seen.append(await request.json())
            return web.Response()

        url = await self.webhook(receive)
        poll = asyncio.create_task(self.bot.get_updates(timeout=1))
        await asyncio.sleep(0.05)
        await self.bot.set_webhook(url, allowed_updates=["callback_query"])
        with self.assertRaises(TelegramConflictError):
            await poll
        await self.emulator.enqueue_update({"message": MESSAGE}, token=TOKEN)
        self.assertEqual(seen, [])
        await self.bot.delete_webhook(drop_pending_updates=True)
        self.assertEqual(await self.bot.get_updates(), [])

    async def test_journal_error_cannot_requeue_acknowledged_webhook(self):
        seen = []

        async def receive(request):
            seen.append(await request.json())
            return web.Response()

        url = await self.webhook(receive)
        await self.bot.set_webhook(url)
        original = self.emulator._update_queues.record

        def fail_webhook_record(item):
            if item.get("event") == "webhook":
                raise OSError("disk is unavailable")
            original(item)

        self.emulator._update_queues.record = fail_webhook_record
        with self.assertRaises(OSError):
            await self.emulator.enqueue_update({"message": MESSAGE}, token=TOKEN)
        self.assertEqual(self.emulator._update_queues.info(TOKEN)["pending_update_count"], 0)
        self.emulator._update_queues.record = original
        self.assertEqual(await self.emulator.deliver_updates(token=TOKEN), 0)
        self.assertEqual(len(seen), 1)

    async def test_control_is_explicit_bounded_and_never_leaks_token_or_content(self):
        async with ClientSession() as client:
            for body in (
                [],
                {"token": TOKEN},
                {"token": TOKEN, "update": {"unknown": {}}},
                {"token": TOKEN, "update": {"message": MESSAGE}, "extra": 1},
            ):
                async with client.post(self.base + "/__fixture/updates", json=body) as response:
                    self.assertEqual(response.status, 400)
            async with client.post(self.base + "/__fixture/updates", data=b"x" * 65537) as response:
                self.assertEqual(response.status, 413)
            async with client.post(
                self.base + f"/bot{TOKEN}/sendMessage",
                json={"chat_id": 42, "text": "private-marker", TOKEN: "hidden"},
            ) as response:
                self.assertEqual(response.status, 400)
            async with client.post(
                self.base + f"/bot{TOKEN}/{TOKEN}", json={TOKEN: "hidden"}
            ) as response:
                self.assertEqual(response.status, 404)
        text = self.journal.read_text()
        self.assertNotIn(TOKEN, text)
        self.assertNotIn("private-marker", text)
        self.assertNotIn("hidden", text)
        self.assertIn("<unknown>", text)

    async def test_queue_validation_limits_and_poll_validation(self):
        small = LoBotApiEmulator(max_updates=1, max_bots=1)
        await small.enqueue_update({"message": MESSAGE}, token=TOKEN)
        for update in ({"message": MESSAGE}, {"update_id": 0, "message": MESSAGE}, {}):
            with self.assertRaises(UpdateError):
                await small.enqueue_update(update, token=TOKEN)
        with self.assertRaises(UpdateError):
            await small.enqueue_update({"message": MESSAGE}, token="other")
        for kwargs in (
            {"limit": True},
            {"timeout": 51},
            {"offset": "1.1"},
            {"allowed_updates": "{}"},
        ):
            with self.assertRaises(UpdateError):
                await small._update_queues.poll(TOKEN, kwargs)
        with self.assertRaises(UpdateError):
            await small._update_queues.set_webhook(TOKEN, {"url": "http://127.0.0.1/hook"})
        with self.assertRaises(UpdateError):
            await small._update_queues.set_webhook(
                TOKEN, {"url": "https://example.invalid/hook", "secret_token": "not safe"}
            )

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, "-c", "from lo_bot_api_emulator import main; main()", *args],
            capture_output=True,
            text=True,
            timeout=10,
        )

    async def test_journal_verdict_is_fail_closed_and_exceptions_are_explicit(self):
        for text in (
            "",
            "not json\n",
            "[]\n",
            '{"method":"sendMessage"}\n',
            '{"method":"sendMessage","status":200}',
            '{"event":"enqueue","update_ids":["bad"],"update_kind":"message"}\n',
            "{}\n",
            "x" * 70000 + "\n",
        ):
            self.journal.write_text(text)
            self.assertNotEqual(
                self.cli("verdict", str(self.journal), "--require-response").returncode, 0
            )
        self.journal.write_text(
            json.dumps({"method": "sendChatAction", "status": 501})
            + "\n"
            + json.dumps({"method": "sendMessage", "status": 200})
            + "\n"
        )
        self.assertFalse(verdict(self.journal, require_response=True)["ok"])
        self.assertTrue(
            verdict(self.journal, require_response=True, allowed_refusals=["sendChatAction:501"])[
                "ok"
            ]
        )
        self.assertFalse(verdict(self.journal, require_methods=["editMessageReplyMarkup"])["ok"])
        self.assertEqual(self.cli("verdict", str(self.journal) + ".missing").returncode, 1)
        methods = json.loads(self.cli("--methods").stdout)
        self.assertEqual(methods["modeled"], sorted(MODELED_METHODS))
        self.assertEqual(
            set(methods["unmodeled_implemented"]),
            {name for name, definition in CONTRACT["methods"].items() if definition["implemented"]}
            - MODELED_METHODS,
        )
