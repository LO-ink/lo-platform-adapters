import unittest

from aiohttp import web
from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest, TelegramRetryAfter, TelegramServerError
from aiogram.methods import SendMessage, SendVideo
from aiogram.types import BufferedInputFile, InputMediaPhoto, InputMediaVideo
from lo_aiogram import LoAiohttpSession, LoBotApiCompat
from lo_bot_api_emulator import LoBotApiEmulator

TOKEN = "123456:" + "A" * 43


class Fixture(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.emulator = LoBotApiEmulator()
        self.runner = web.AppRunner(self.emulator.app())
        await self.runner.setup()
        self.addAsyncCleanup(self.runner.cleanup)
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.base = f"http://127.0.0.1:{self.runner.addresses[0][1]}"
        self.clock = 0
        self.waits = []
        async def sleep(seconds):
            self.waits.append(seconds)
        self.compat = LoBotApiCompat(clock=lambda: self.clock, sleep=sleep, probe_capabilities=False)
        self.bot = self.new_bot()

    def new_bot(self, compatibility=True):
        session = LoAiohttpSession(base_url=self.base, allow_insecure_loopback=True, compatibility=False, timeout=2)
        if compatibility:
            session.middleware(self.compat)
        bot = Bot(TOKEN, session=session)
        self.addAsyncCleanup(session.close)
        return bot

    def upload(self, name="video.mp4"):
        return BufferedInputFile(b"fixture-bytes", filename=name)



class Conformance(Fixture):
    async def test_reply_filters_unknown_fields_and_returns_message_not_envelope(self):
        message = await self.bot.send_message(42, "First")
        with self.assertLogs("lo_aiogram", level="WARNING") as logs:
            reply = await message.reply("Reply", disable_notification=True)
        self.assertEqual(reply.text, "Reply")
        self.assertEqual(reply.chat.id, 42)
        self.assertNotIn("reply_parameters", self.emulator.requests[-1]["fields"])
        self.assertNotIn("disable_notification", self.emulator.requests[-1]["fields"])
        self.assertNotIn(TOKEN, "".join(logs.output))
        self.assertEqual(sum(row["status"] == 400 for row in self.emulator.requests), 0)

    async def test_removing_adapter_causes_real_reply_rejection(self):
        raw = self.new_bot(False)
        message = await raw.send_message(42, "First")
        with self.assertRaises(TelegramBadRequest):
            await message.reply("Reply", disable_notification=True)
        self.assertEqual(self.emulator.requests[-1]["status"], 400)

    async def test_single_upload_works_on_legacy_server_and_thumbnail_is_a_file(self):
        self.emulator.single_attach = False
        message = await self.bot.send_video(42, self.upload(), duration=2, width=640, height=360, thumbnail=self.upload("poster.jpg"), supports_streaming=True)
        self.assertIsNotNone(message.video)
        self.assertEqual(self.emulator.requests[-1]["files"], ["thumbnail", "video"])

    async def test_cached_video_drops_upload_only_fields(self):
        uploaded = await self.bot.send_video(42, self.upload())
        result = await self.bot.send_video(42, uploaded.video.file_id, duration=2, width=2, height=2, thumbnail=self.upload("poster.jpg"))
        self.assertIsNotNone(result.video)
        self.assertNotIn("duration", self.emulator.requests[-1]["fields"])
        self.assertEqual(self.emulator.requests[-1]["files"], [])

    async def test_video_disabled_falls_back_and_cache_expires(self):
        self.emulator.video_uploads = False
        result = await self.bot.send_video(42, self.upload())
        self.assertIsNotNone(result.document)
        before = len(self.emulator.requests)
        await self.bot.send_video(42, self.upload())
        self.assertEqual(len(self.emulator.requests), before + 1)
        self.assertEqual(self.emulator.requests[-1]["method"], "sendDocument")
        self.emulator.video_uploads = True
        self.clock = 301
        result = await self.bot.send_video(42, self.upload())
        self.assertIsNotNone(result.video)

    async def test_video_429_retries_once_then_uses_document_without_caching_feature(self):
        self.emulator.video_retry_count = 2
        result = await self.bot.send_video(42, self.upload())
        self.assertIsNotNone(result.document)
        self.assertEqual(self.waits, [10])
        self.assertEqual([row["method"] for row in self.emulator.requests], ["sendVideo", "sendVideo", "sendDocument"])
        result = await self.bot.send_video(42, self.upload())
        self.assertIsNotNone(result.video)

    async def test_video_retry_ceiling_preserves_refusal(self):
        self.compat.max_video_retry_after = 5
        self.emulator.video_retry_count = 1
        with self.assertRaises(TelegramRetryAfter):
            await self.bot.send_video(42, self.upload())
        self.assertEqual(len(self.emulator.requests), 1)
        self.assertEqual(self.waits, [])

    async def test_mixed_album_splits_after_native_refusal_and_preserves_order(self):
        result = await self.bot.send_media_group(42, [InputMediaPhoto(media=self.upload("a.png")), InputMediaVideo(media=self.upload(), duration=2, thumbnail=self.upload("poster.jpg")), InputMediaPhoto(media=self.upload("b.png"))])
        self.assertEqual(len(result), 3)
        self.assertIsNotNone(result[0].photo)
        self.assertIsNotNone(result[1].video)
        self.assertIsNotNone(result[2].photo)
        self.assertEqual(self.emulator.requests[0]["status"], 400)
        self.assertIn("thumbnail", self.emulator.requests[2]["files"])

    async def test_native_photo_album_has_one_lo_message_id(self):
        result = await self.bot.send_media_group(42, [InputMediaPhoto(media=self.upload("a.png"), caption="First"), InputMediaPhoto(media=self.upload("b.png"), caption="Second")])
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].message_id, result[1].message_id)
        self.assertEqual(result[0].caption, "First")
        self.assertIsNone(result[1].caption)

    async def test_chat_action_501_is_cached_and_other_501_is_not_swallowed(self):
        self.assertTrue(await self.bot.send_chat_action(42, "upload_video"))
        before = len(self.emulator.requests)
        self.assertTrue(await self.bot.send_chat_action(42, "upload_video"))
        self.assertEqual(len(self.emulator.requests), before)
        with self.assertRaises(TelegramServerError):
            await self.bot.send_dice(42)

    async def test_unsupported_field_retry_runs_once_without_files_and_is_remembered(self):
        original = self.emulator.validate
        def reject(method, fields, uploads):
            if method == "sendMessage" and "parse_mode" in fields:
                from lo_bot_api_emulator import ApiRefusal
                raise ApiRefusal("Bad Request: parse_mode is not supported yet")
            return original(method, fields, uploads)
        self.emulator.validate = reject
        await self.bot.send_message(42, "Text", parse_mode="HTML")
        self.assertEqual(len(self.emulator.requests), 2)
        await self.bot.send_message(42, "Text", parse_mode="HTML")
        self.assertEqual(len(self.emulator.requests), 3)

    async def test_file_upload_unknown_refusal_is_not_replayed(self):
        original = self.emulator.validate
        def reject(method, fields, uploads):
            if method == "sendPhoto":
                from lo_bot_api_emulator import ApiRefusal
                raise ApiRefusal("Bad Request: parse_mode is not supported yet")
            return original(method, fields, uploads)
        self.emulator.validate = reject
        with self.assertRaises(TelegramBadRequest):
            await self.bot.send_photo(42, self.upload("photo.png"), parse_mode="HTML")
        self.assertEqual(len(self.emulator.requests), 1)

    async def test_non_json_503_is_temporary_and_sends_are_not_retried(self):
        method = SendMessage(chat_id=42, text="Text")
        with self.assertRaises(TelegramServerError) as caught:
            self.bot.session.check_response(self.bot, method, 503, "<html>private edge detail</html>")
        self.assertNotIn("private", str(caught.exception))

    async def test_file_metadata_and_authenticated_download(self):
        result = await self.bot.send_document(42, self.upload("test.txt"))
        metadata = await self.bot.get_file(result.document.file_id)
        output = await self.bot.download_file(metadata.file_path)
        self.assertEqual(output.getvalue(), b"fixture-bytes")


class Configuration(unittest.TestCase):
    def test_session_refuses_external_http_or_credential_urls(self):
        for base in ("http://example.test", "https://user:secret@example.test", "https://example.test?token=x"):
            with self.assertRaises(ValueError):
                LoAiohttpSession(base_url=base)


if __name__ == "__main__":
    unittest.main()
