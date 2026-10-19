import asyncio
import json
import unittest
from unittest.mock import patch

from aiogram import Bot
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.exceptions import (
    TelegramAPIError,
    TelegramBadRequest,
    TelegramNetworkError,
    TelegramRetryAfter,
    TelegramServerError,
)
from aiogram.methods import SendMediaGroup, SendMessage, SendPhoto, SendVideo
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InputFile,
    InputMediaAudio,
    InputMediaDocument,
    InputMediaPhoto,
    InputMediaVideo,
    KeyboardButton,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
)
from lo_aiogram.compat import LoBotCompat, PartialDeliveryError
from lo_bot_api_emulator import ApiRefusal
from test_conformance import TOKEN, Fixture


class OneShot(InputFile):
    async def read(self, bot):
        yield b"one-shot"


class Compat(Fixture):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.compat = LoBotCompat()
        self.bot.session.middleware(self.compat)

    async def test_unsupported_fields_removed_once_original_method_unchanged(self):
        first = await self.bot.send_message(42, "first")
        with self.assertLogs("lo_aiogram.compat", level="WARNING") as logs:
            await first.reply("second", disable_notification=True, protect_content=True)
            await first.reply("third", disable_notification=True, protect_content=True)
        self.assertEqual(sum("protect_content" in line for line in logs.output), 1)
        self.assertEqual(sum("disable_notification" in line for line in logs.output), 0)
        self.assertTrue(all(row["status"] == 200 for row in self.emulator.requests))
        original = SendMessage(
            chat_id=42, text="keep", disable_notification=True, custom_extra="private"
        )
        with self.assertLogs("lo_aiogram.compat", level="WARNING") as extra:
            await self.bot(original)
        self.assertTrue(original.disable_notification)
        self.assertEqual(original.custom_extra, "private")
        self.assertNotIn("private", str(extra.output))

    async def test_reply_keyboard_and_removal_do_not_corrupt_successful_message(self):
        for markup in (
            ReplyKeyboardMarkup(keyboard=[[KeyboardButton(text="Choose")]]),
            ReplyKeyboardRemove(remove_keyboard=True),
        ):
            result = await self.bot.send_message(42, "keyboard", reply_markup=markup)
            self.assertEqual(result.text, "keyboard")
            self.assertIsNone(result.reply_markup)
        self.assertTrue(all(row["status"] == 200 for row in self.emulator.requests))

    async def test_cached_video_strips_upload_only_without_uploading_thumbnail(self):
        first = await self.bot.send_video(42, self.upload())
        result = await self.bot.send_video(
            42,
            first.video.file_id,
            duration=3,
            width=640,
            height=480,
            thumbnail=self.upload("cover.jpg"),
        )
        self.assertEqual(result.video.file_id, first.video.file_id)
        self.assertEqual(self.emulator.requests[-1]["files"], [])
        self.assertNotIn("duration", self.emulator.requests[-1]["fields"])

    async def test_audio_upload_uses_document_before_any_refused_request(self):
        keyboard = InlineKeyboardMarkup(
            inline_keyboard=[[InlineKeyboardButton(text="Again", callback_data="again")]]
        )
        with patch.object(self.emulator, "validate", wraps=self.emulator.validate) as received:
            result = await self.bot.send_audio(
                42,
                self.upload("sound.mp3"),
                caption="Sound",
                title="Title",
                duration=2,
                reply_markup=keyboard,
                disable_notification=True,
            )
        fields = received.call_args.args[1]
        self.assertIsNotNone(result.document)
        self.assertIsNone(result.audio)
        self.assertEqual(result.caption, "Sound")
        self.assertEqual(json.loads(fields["reply_markup"]), keyboard.model_dump(exclude_none=True))
        self.assertEqual([row["method"] for row in self.emulator.requests], ["sendDocument"])
        self.assertTrue(all(row["status"] == 200 for row in self.emulator.requests))
        self.assertNotIn("duration", self.emulator.requests[0]["fields"])
        self.assertNotIn("title", self.emulator.requests[0]["fields"])

    async def test_audio_cached_id_is_not_converted_and_one_shot_is_not_replayed(self):
        self.emulator.assets["cached-audio"] = {"data": b"audio", "size": 5}
        cached = await self.bot.send_audio(42, "cached-audio")
        self.assertIsNotNone(cached.audio)
        result = await self.bot.send_audio(42, OneShot(filename="sound.mp3"))
        self.assertIsNotNone(result.document)
        self.assertEqual(
            [row["method"] for row in self.emulator.requests], ["sendAudio", "sendDocument"]
        )

    async def test_feature_disabled_falls_back_once_and_preserves_caption_keyboard(self):
        self.emulator.video_uploads = False
        result = await self.bot.send_video(
            42, self.upload(), caption="caption", disable_notification=True
        )
        self.assertIsNotNone(result.document)
        self.assertEqual(result.caption, "caption")
        self.assertEqual(
            [x["method"] for x in self.emulator.requests], ["sendVideo", "sendDocument"]
        )
        self.assertEqual(len(self.emulator.assets), 1)

    async def test_unknown_upload_and_cached_id_are_not_replayed_as_documents(self):
        self.emulator.video_uploads = False
        with self.assertRaises(TelegramBadRequest):
            await self.bot.send_video(42, OneShot(filename="video.mp4"))
        self.emulator.assets["cached"] = {"data": b"x", "size": 1}
        result = await self.bot.send_video(42, "cached")
        self.assertIsNotNone(result.video)
        self.assertNotIn("sendDocument", [x["method"] for x in self.emulator.requests])

    async def test_split_preserves_order_and_captions(self):
        media = [
            InputMediaPhoto(media=self.upload("1.jpg"), caption="first"),
            InputMediaPhoto(media=self.upload("2.jpg")),
            InputMediaVideo(media=self.upload("3.mp4"), caption="video"),
            InputMediaPhoto(media=self.upload("4.jpg"), caption="last"),
        ]
        results = await self.bot.send_media_group(42, media, disable_notification=True)
        self.assertEqual(
            [x["method"] for x in self.emulator.requests],
            ["sendMediaGroup", "sendVideo", "sendPhoto"],
        )
        self.assertEqual(len(results), 4)
        self.assertEqual([x.caption for x in results], ["first", None, "video", "last"])

    async def test_captions_documents_and_extra_media_fields(self):
        results = await self.bot.send_media_group(
            42,
            [
                InputMediaPhoto(media=self.upload("1.jpg"), has_spoiler=True),
                InputMediaPhoto(media=self.upload("2.jpg")),
                InputMediaPhoto(media=self.upload("3.jpg"), caption="own caption"),
                InputMediaDocument(media=self.upload("4.pdf")),
            ],
        )
        self.assertEqual(len(results), 4)
        self.assertEqual(
            [x["method"] for x in self.emulator.requests],
            ["sendMediaGroup", "sendPhoto", "sendDocument"],
        )
        self.assertTrue(all(row["status"] == 200 for row in self.emulator.requests))

    async def test_preflight_rejects_unsupported_album_before_any_delivery(self):
        with self.assertRaises(ValueError):
            await self.bot.send_media_group(
                42, [InputMediaPhoto(media=self.upload()), InputMediaAudio(media=self.upload())]
            )
        with self.assertRaises(ValueError):
            await self.bot.send_media_group(42, [InputMediaPhoto(media=self.upload())])
        self.assertEqual(self.emulator.requests, [])

    async def test_partial_album_reports_completed_and_keeps_original_cause(self):
        with self.assertRaises(PartialDeliveryError) as caught:
            await self.bot.send_media_group(
                42, [InputMediaPhoto(media=self.upload()), InputMediaVideo(media="missing")]
            )
        self.assertEqual(len(caught.exception.completed), 1)
        self.assertIsInstance(caught.exception.__cause__, TelegramBadRequest)
        self.assertEqual(self.emulator.next_id, 2)

    async def test_safe_429_retries_once_but_not_indefinitely(self):
        self.emulator.video_retry_count = 1
        with patch("lo_aiogram.compat.asyncio.sleep", new=self.immediate_sleep):
            result = await self.bot.send_video(42, self.upload())
        self.assertIsNotNone(result.video)
        self.assertEqual(len(self.emulator.requests), 2)
        self.assertEqual(self.emulator.next_id, 2)
        self.emulator.video_retry_count = 2
        with (
            patch("lo_aiogram.compat.asyncio.sleep", new=self.immediate_sleep),
            self.assertRaises(TelegramRetryAfter),
        ):
            await self.bot.send_video(42, self.upload())
        self.assertEqual(len(self.emulator.requests), 4)
        self.assertEqual(self.emulator.next_id, 2)

    async def immediate_sleep(self, delay):
        self.assertEqual(delay, 10)

    async def test_unknown_or_unbounded_refusal_never_retries(self):
        original = self.emulator.validate
        for parameters in (
            {"retry_after": 0},
            {"retry_after": 0, "safe_to_retry": "true"},
            {"retry_after": 61, "safe_to_retry": True},
        ):

            def refuse(*args, parameters=parameters):
                raise ApiRefusal("limited", 429, parameters)

            self.emulator.validate = refuse
            before = len(self.emulator.requests)
            with self.assertRaises(TelegramAPIError):
                await self.bot.send_message(42, "x")
            self.assertEqual(len(self.emulator.requests), before + 1)
        self.emulator.validate = original
        self.emulator.video_retry_count = 1
        with self.assertRaises(TelegramRetryAfter):
            await self.bot.send_video(42, OneShot(filename="one.mp4"))

    async def test_only_structured_cosmetic_501_is_a_local_noop(self):
        original = self.emulator.validate

        def legacy(method, fields, uploads):
            if method == "sendChatAction":
                raise ApiRefusal("legacy", 501, {"reason": "method_not_implemented"})
            return original(method, fields, uploads)

        self.emulator.validate = legacy
        self.assertTrue(await self.bot.send_chat_action(42, "typing"))
        self.assertTrue(await self.bot.send_chat_action(42, "typing"))
        self.assertEqual(len(self.emulator.requests), 1)
        with self.assertRaises(TelegramServerError):
            await self.bot.get_chat(42)

        def fail(*args):
            raise ApiRefusal("broken", 500, {"reason": "method_not_implemented"})

        self.emulator.validate = fail
        self.bot.session.middleware.unregister(self.compat)
        self.bot.session.middleware(LoBotCompat())
        with self.assertRaises(TelegramServerError):
            await self.bot.send_chat_action(42, "typing")

    async def test_secretary_context_is_rejected_before_omission(self):
        for fields in (
            {"business_connection_id": "owner"},
            {"lo_context": {}},
            {"lo_request_id": "owner"},
        ):
            with self.assertRaises(ValueError):
                await self.bot(SendMessage(chat_id=42, text="x", **fields))
        self.assertEqual(self.emulator.requests, [])

    async def test_wrong_transport_network_and_server_errors_not_adapted(self):
        other = Bot(TOKEN, session=AiohttpSession())
        self.addAsyncCleanup(other.session.close)

        async def unused(*args):
            self.fail("Unexpected transport call")

        with self.assertRaises(ValueError):
            await self.compat(unused, other, SendMessage(chat_id=42, text="x"))
        for error_type in (TelegramNetworkError, TelegramServerError):
            calls = []

            async def fail(bot, method, calls=calls, error_type=error_type):
                calls.append(1)
                raise error_type(method=method, message="failed")

            with self.assertRaises(error_type):
                await self.compat(fail, self.bot, SendMessage(chat_id=42, text="x"))
            self.assertEqual(len(calls), 1)

    async def test_partial_cancel_keeps_cancellation_semantics(self):
        async def send(bot, method):
            if isinstance(method, SendPhoto):
                return await self.bot.session.make_request(bot, method)
            raise asyncio.CancelledError()

        method = SendMediaGroup(
            chat_id=42,
            media=[InputMediaPhoto(media=self.upload()), InputMediaVideo(media=self.upload())],
        )
        with self.assertRaises(asyncio.CancelledError) as caught:
            await self.compat(send, self.bot, method)
        self.assertEqual(len(caught.exception.completed), 1)


class RetryMetadata(unittest.IsolatedAsyncioTestCase):
    async def test_safe_marker_requires_matching_http_and_envelope_codes(self):
        from lo_aiogram import LoAiohttpSession

        session = LoAiohttpSession()
        self.addAsyncCleanup(session.close)
        bot = Bot(TOKEN, session=session)
        for status, code in [(429, 429), (400, 429), (429, 400)]:
            with self.assertRaises((TelegramRetryAfter, TelegramBadRequest)) as caught:
                session.check_response(
                    bot,
                    SendVideo(chat_id=42, video="x"),
                    status,
                    json.dumps(
                        {
                            "ok": False,
                            "error_code": code,
                            "description": "limited",
                            "parameters": {"retry_after": 1, "safe_to_retry": True},
                        }
                    ),
                )
            self.assertEqual(
                getattr(caught.exception, "lo_safe_to_retry", False), status == code == 429
            )
