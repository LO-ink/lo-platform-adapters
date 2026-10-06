import unittest

from aiogram import Bot
from aiogram.exceptions import TelegramBadRequest, TelegramRetryAfter, TelegramServerError
from aiogram.methods import SendMessage
from aiogram.types import BufferedInputFile, InputMediaPhoto, InputMediaVideo
from aiohttp import web
from lo_aiogram import LoAiohttpSession
from lo_bot_api_emulator import ApiRefusal, LoBotApiEmulator

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
        self.bot = self.new_bot()

    def new_bot(self):
        session = LoAiohttpSession(base_url=self.base, allow_insecure_loopback=True, timeout=2)
        self.addAsyncCleanup(session.close)
        return Bot(TOKEN, session=session)

    def upload(self, name="video.mp4"):
        return BufferedInputFile(b"fixture-bytes", filename=name)


class Conformance(Fixture):
    async def test_success_returns_aiogram_message(self):
        message = await self.bot.send_message(42, "First")
        self.assertEqual(message.text, "First")
        self.assertEqual(message.chat.id, 42)

    async def test_unsupported_reply_fields_are_not_silently_removed(self):
        message = await self.bot.send_message(42, "First")
        with self.assertRaises(TelegramBadRequest):
            await message.reply("Reply", disable_notification=True)
        self.assertIn("reply_parameters", self.emulator.requests[-1]["fields"])
        self.assertIn("disable_notification", self.emulator.requests[-1]["fields"])
        self.assertEqual(len(self.emulator.requests), 2)

    async def test_single_upload_and_thumbnail_have_parameter_named_parts(self):
        self.emulator.single_attach = False
        message = await self.bot.send_video(
            42,
            self.upload(),
            duration=2,
            width=640,
            height=360,
            thumbnail=self.upload("poster.jpg"),
            supports_streaming=True,
        )
        self.assertIsNotNone(message.video)
        self.assertEqual(self.emulator.requests[-1]["files"], ["thumbnail", "video"])

    async def test_cached_video_upload_metadata_is_rejected_once(self):
        uploaded = await self.bot.send_video(42, self.upload())
        with self.assertRaises(TelegramBadRequest):
            await self.bot.send_video(
                42, uploaded.video.file_id, duration=2, thumbnail=self.upload("poster.jpg")
            )
        self.assertEqual(len(self.emulator.requests), 2)
        self.assertIn("duration", self.emulator.requests[-1]["fields"])

    async def test_disabled_video_never_becomes_document(self):
        self.emulator.video_uploads = False
        for _ in range(2):
            with self.assertRaises(TelegramBadRequest) as caught:
                await self.bot.send_video(42, self.upload())
            self.assertEqual(caught.exception.lo_reason, "feature_disabled")
            self.assertEqual(caught.exception.lo_parameter, "video")
        self.assertEqual(
            [row["method"] for row in self.emulator.requests], ["sendVideo", "sendVideo"]
        )
        self.assertEqual(self.emulator.assets, {})

    async def test_rate_limited_video_is_not_retried_or_converted(self):
        self.emulator.video_retry_count = 2
        with self.assertRaises(TelegramRetryAfter):
            await self.bot.send_video(42, self.upload())
        self.assertEqual([row["method"] for row in self.emulator.requests], ["sendVideo"])

    async def test_mixed_album_is_not_split_after_refusal(self):
        with self.assertRaises(TelegramBadRequest):
            await self.bot.send_media_group(
                42,
                [InputMediaPhoto(media=self.upload("a.png")), InputMediaVideo(media=self.upload())],
            )
        self.assertEqual([row["method"] for row in self.emulator.requests], ["sendMediaGroup"])
        self.assertEqual(self.emulator.assets, {})

    async def test_homogeneous_album_preserves_supported_caption(self):
        result = await self.bot.send_media_group(
            42,
            [
                InputMediaPhoto(media=self.upload("a.png"), caption="First"),
                InputMediaPhoto(media=self.upload("b.png")),
            ],
        )
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].message_id, result[1].message_id)
        self.assertEqual(result[0].caption, "First")

    async def test_chat_action_501_never_returns_fabricated_success(self):
        for _ in range(2):
            with self.assertRaises(TelegramServerError):
                await self.bot.send_chat_action(42, "upload_video")
        self.assertEqual(
            [row["method"] for row in self.emulator.requests], ["sendChatAction", "sendChatAction"]
        )

    async def test_structured_field_refusal_propagates_without_changed_request(self):
        original = self.emulator.validate

        def reject(method, fields, uploads):
            if method == "sendMessage" and "parse_mode" in fields:
                raise ApiRefusal(
                    "Readable text can change",
                    parameters={"reason": "unsupported_parameter", "parameter": "parse_mode"},
                )
            return original(method, fields, uploads)

        self.emulator.validate = reject
        for _ in range(2):
            with self.assertRaises(TelegramBadRequest) as caught:
                await self.bot.send_message(42, "Text", parse_mode="HTML")
            self.assertEqual(caught.exception.lo_reason, "unsupported_parameter")
        self.assertEqual(len(self.emulator.requests), 2)
        self.assertTrue(all("parse_mode" in row["fields"] for row in self.emulator.requests))

    async def test_non_json_503_is_temporary_without_exposing_response_body(self):
        method = SendMessage(chat_id=42, text="Text")
        with self.assertRaises(TelegramServerError) as caught:
            self.bot.session.check_response(
                self.bot, method, 503, "<html>private edge detail</html>"
            )
        self.assertNotIn("private", str(caught.exception))

    async def test_file_metadata_and_authenticated_download(self):
        result = await self.bot.send_document(42, self.upload("test.txt"))
        metadata = await self.bot.get_file(result.document.file_id)
        output = await self.bot.download_file(metadata.file_path)
        self.assertEqual(output.getvalue(), b"fixture-bytes")


class Configuration(unittest.TestCase):
    def test_session_refuses_external_http_or_credential_urls(self):
        for base in (
            "http://example.test",
            "https://user:secret@example.test",
            "https://example.test?token=x",
        ):
            with self.assertRaises(ValueError):
                LoAiohttpSession(base_url=base)
