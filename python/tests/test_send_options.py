import json
from unittest.mock import patch

from aiogram.client.default import DefaultBotProperties
from aiogram.exceptions import TelegramBadRequest
from aiogram.methods import SendMessage
from aiogram.types import InputMediaPhoto, InputMediaVideo, ReplyParameters
from aiohttp import ClientSession
from lo_aiogram.compat import LoBotCompat
from test_conformance import TOKEN, Fixture


class SendOptions(Fixture):
    async def test_implicit_quote_parse_mode_is_normalized_only_by_explicit_compat(self):
        self.bot.default = DefaultBotProperties(parse_mode="HTML")
        message = await self.bot.send_message(42, "first")
        with self.assertRaises(TelegramBadRequest):
            await message.reply("strict")
        self.bot.session.middleware(LoBotCompat())
        with self.assertLogs("lo_aiogram.compat", level="WARNING") as logs:
            await message.reply("<b>second</b>")
            await message.reply("third")
        self.assertEqual(
            sum("reply_parameters.quote_parse_mode" in line for line in logs.output), 1
        )
        for reply in (
            ReplyParameters(message_id=1, quote="explicit"),
            ReplyParameters(message_id=1, quote_parse_mode="HTML"),
        ):
            with self.assertRaises(TelegramBadRequest):
                await self.bot.send_message(42, "refused", reply_parameters=reply)
        self.assertEqual(self.emulator.next_id, 4)

    async def test_strict_reply_and_silent_fields_reach_transport_unchanged(self):
        with patch.object(self.emulator, "validate", wraps=self.emulator.validate) as receive:
            message = await self.bot.send_message(42, "first")
            await message.reply("second", disable_notification=True)
        fields = receive.call_args.args[1]
        self.assertEqual(json.loads(fields["reply_parameters"])["message_id"], message.message_id)
        self.assertEqual(fields["disable_notification"], "true")
        await self.bot(
            SendMessage(
                chat_id=42,
                text="legacy",
                reply_to_message_id=1,
                allow_sending_without_reply=True,
                disable_notification=False,
            )
        )
        self.assertTrue(all(row["status"] == 200 for row in self.emulator.requests))

    async def test_mixed_album_propagates_reply_and_silent_options_to_every_part(self):
        self.bot.session.middleware(LoBotCompat())
        self.emulator.video_uploads = False
        for legacy in (False, True):
            options = (
                {"reply_to_message_id": 10, "allow_sending_without_reply": True}
                if legacy
                else {
                    "reply_parameters": ReplyParameters(
                        message_id=10, chat_id=42, allow_sending_without_reply=True
                    )
                }
            )
            with patch.object(self.emulator, "validate", wraps=self.emulator.validate) as receive:
                result = await self.bot.send_media_group(
                    42,
                    [
                        InputMediaPhoto(media=self.upload("one.jpg")),
                        InputMediaPhoto(media=self.upload("two.jpg")),
                        InputMediaVideo(media=self.upload("three.mp4")),
                        InputMediaPhoto(media=self.upload("four.jpg"), caption="last"),
                    ],
                    disable_notification=True,
                    **options,
                )
            self.assertEqual(len(result), 4)
            self.assertEqual(
                [call.args[0] for call in receive.call_args_list],
                ["sendMediaGroup", "sendVideo", "sendDocument", "sendPhoto"],
            )
            for call in receive.call_args_list:
                fields = call.args[1]
                self.assertEqual(fields["disable_notification"], "true")
                if legacy:
                    self.assertEqual(fields["reply_to_message_id"], "10")
                    self.assertEqual(fields["allow_sending_without_reply"], "true")
                else:
                    self.assertEqual(json.loads(fields["reply_parameters"])["message_id"], 10)
                    self.assertTrue(
                        json.loads(fields["reply_parameters"])["allow_sending_without_reply"]
                    )

    async def test_audio_document_fallback_preserves_send_options(self):
        self.bot.session.middleware(LoBotCompat())
        with patch.object(self.emulator, "validate", wraps=self.emulator.validate) as receive:
            result = await self.bot.send_audio(
                42,
                self.upload("audio.mp3"),
                disable_notification=True,
                reply_parameters=ReplyParameters(message_id=10),
            )
        self.assertIsNotNone(result.document)
        fields = receive.call_args.args[1]
        self.assertEqual(fields["disable_notification"], "true")
        self.assertEqual(json.loads(fields["reply_parameters"])["message_id"], 10)

    async def test_invalid_reply_options_refuse_without_delivery(self):
        for options in (
            {"reply_parameters": {"message_id": 1, "quote": "unsupported"}},
            {"reply_parameters": {"message_id": 1, "chat_id": -42}},
            {"reply_parameters": {"message_id": 0}},
            {"reply_parameters": {"message_id": 2**31}},
            {"reply_to_message_id": 2**31},
        ):
            with self.subTest(options=options), self.assertRaises(TelegramBadRequest):
                await self.bot(SendMessage(chat_id=42, text="refused", **options))
            self.assertEqual(self.emulator.next_id, 1)
            self.assertEqual(self.emulator.assets, {})

    async def test_chat_action_is_real_fixture_request_each_time_and_validated(self):
        self.bot.session.middleware(LoBotCompat())
        self.assertTrue((await self.bot.get_me()).capabilities["chat_actions"])
        for action in ("typing", "record_voice", "upload_video"):
            self.assertTrue(await self.bot.send_chat_action(42, action))
        self.assertEqual(
            sum(row["method"] == "sendChatAction" for row in self.emulator.requests), 3
        )
        with self.assertRaises(TelegramBadRequest):
            await self.bot.send_chat_action(42, "not_an_action")

    async def test_raw_send_option_bindings_match_server_without_python_integer_extensions(self):
        cases = [
            ({"disable_notification": value, "allow_sending_without_reply": value}, 200)
            for value in (True, False, "true", "false", "invalid", {}, [], 1, 0)
        ]
        cases += [
            ({"reply_parameters": None}, 200),
            ({"reply_parameters": None, "reply_to_message_id": "1"}, 200),
            ({"reply_parameters": None, "reply_to_message_id": None}, 400),
            ({"reply_parameters": "null"}, 400),
        ]
        cases += [
            ({"reply_to_message_id": value}, status)
            for value, status in (
                (" +1 ", 200),
                ("01", 200),
                (1.0, 200),
                ("1_0", 400),
                ("١", 400),
                ("１", 400),
                (1.5, 400),
            )
        ]
        cases += [
            ({"reply_parameters": {"message_id": 1, "allow_sending_without_reply": value}}, status)
            for value, status in ((True, 200), (False, 200), (None, 200), ("true", 400), (1, 400))
        ]
        cases += [
            ({"reply_parameters": {"message_id": 1, "chat_id": value}}, status)
            for value, status in (("+042", 200), (" 42", 400), ("4_2", 400), (42.0, 400))
        ]
        async with ClientSession() as client:
            for options, status in cases:
                with self.subTest(options=options):
                    before = self.emulator.next_id
                    async with client.post(
                        self.base + f"/bot{TOKEN}/sendMessage",
                        json={"chat_id": 42, "text": "fixture", **options},
                    ) as response:
                        self.assertEqual(response.status, status)
                    self.assertEqual(self.emulator.next_id, before + (status == 200))
