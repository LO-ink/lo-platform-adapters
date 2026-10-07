import json
import unittest
from unittest.mock import patch

from aiohttp import FormData
from lo_bot_api_emulator import ApiRefusal, LoBotApiEmulator, main
from test_conformance import Fixture


class EmulatorRequestBoundaries(Fixture):
    async def test_nonfinite_chat_ids_return_json_refusals_without_state_changes(self):
        await self.bot.session.create_session()
        for method, extra in (
            ("deleteMessage", '"message_id":1'),
            ("editMessageText", '"message_id":1,"text":"x"'),
            ("sendMessage", '"text":"x"'),
        ):
            for value in ("1e999", "-1e999", "42.5", "true"):
                with self.subTest(method=method, value=value):
                    async with self.bot.session._session.post(
                        f"{self.base}/botfixture/{method}",
                        data='{"chat_id":' + value + "," + extra + "}",
                        headers={"content-type": "application/json"},
                    ) as response:
                        self.assertEqual(response.status, 400)
                        self.assertEqual(response.content_type, "application/json")
                        self.assertFalse((await response.json())["ok"])
                    self.assertEqual(self.emulator.requests[-1]["status"], 400)
                    self.assertEqual(self.emulator.assets, {})
                    self.assertEqual(self.emulator.next_id, 1)

    async def test_keyboard_actions_and_nested_scalars_match_server_refusals(self):
        await self.bot.session.create_session()
        invalid = [
            {"inline_keyboard": [[]]},
            {"inline_keyboard": [[{"text": "x"}]]},
            {"inline_keyboard": [[{"text": "x", "callback_data": ""}]]},
            {"inline_keyboard": [[{"text": "x", "callback_data": {}}]]},
            {"inline_keyboard": [[{"text": "x", "callback_data": "я" * 33}]]},
            {"inline_keyboard": [[{"text": "x", "callback_data": "\ud800"}]]},
            {
                "inline_keyboard": [
                    [{"text": "x", "callback_data": "go", "url": "https://example.test"}]
                ]
            },
            {"inline_keyboard": [[{"text": "x", "pay": True}]]},
            {"inline_keyboard": [[{"text": "x", "url": "javascript:alert(1)"}]]},
            {"inline_keyboard": [[{"text": "x", "url": "https://example.test/%bad%"}]]},
            {"inline_keyboard": [[{"text": "x", "url": "https://bad host.test"}]]},
            {"inline_keyboard": [[{"text": "x", "web_app": {"url": "http://example.test"}}]]},
            {
                "inline_keyboard": [
                    [{"text": "x", "web_app": {"url": "https://example.test", "unknown": True}}]
                ]
            },
            {"inline_keyboard": [[{"text": "x", "copy_text": {"text": ""}}]]},
            {"inline_keyboard": [[{"text": "x", "switch_inline_query": {}}]]},
            {"keyboard": [[{"text": "x", "request_contact": {}}]]},
            {"keyboard": [[{"text": "x", "request_location": "true"}]]},
            {"keyboard": [[{"text": "x", "request_contact": True, "request_location": True}]]},
            {
                "keyboard": [
                    [
                        {
                            "text": "x",
                            "request_contact": True,
                            "web_app": {"url": "https://example.test"},
                        }
                    ]
                ]
            },
            {"keyboard": [[{"text": "x", "web_app": {"url": "https://user@example.test"}}]]},
        ]
        for markup in invalid:
            with self.subTest(markup=markup):
                async with self.bot.session._session.post(
                    f"{self.base}/botfixture/sendMessage",
                    json={"chat_id": 42, "text": "x", "reply_markup": markup},
                ) as response:
                    self.assertEqual(response.status, 400)
                    self.assertEqual(response.content_type, "application/json")
                    self.assertFalse((await response.json())["ok"])
                self.assertEqual(self.emulator.requests[-1]["status"], 400)
                self.assertEqual(self.emulator.assets, {})
                self.assertEqual(self.emulator.next_id, 1)

    async def test_invalid_targets_callbacks_and_caption_types_return_json_refusals(self):
        await self.bot.session.create_session()
        uploaded = await self.bot.send_photo(42, self.upload("fixture.png"))
        reference = uploaded.photo[0].file_id
        original_assets, original_next = dict(self.emulator.assets), self.emulator.next_id
        invalid = [
            ("editMessageText", {"chat_id": 42, "text": "changed"}),
            ("answerCallbackQuery", {}),
            ("answerCallbackQuery", {"callback_query_id": ""}),
            ("answerCallbackQuery", {"callback_query_id": {}}),
        ]
        for value in (None, 0, -1, True, [], {}, "bad", str(2**63), "١"):
            invalid.append(("editMessageText", {"chat_id": 42, "message_id": value, "text": "x"}))
            invalid.append(("deleteMessage", {"chat_id": 42, "message_id": value}))
        for value in (None, 0, True, [], {}, "bad", str(2**63)):
            invalid.append(("deleteMessage", {"chat_id": value, "message_id": 1}))
        for caption in ({"invalid": True}, []):
            invalid.append(("sendPhoto", {"chat_id": 42, "photo": reference, "caption": caption}))
        for markup in ({"invalid": True}, {"inline_keyboard": {}}, {"keyboard": []}):
            invalid.append(("sendMessage", {"chat_id": 42, "text": "x", "reply_markup": markup}))
        for method, fields in invalid:
            with self.subTest(method=method, fields=fields):
                async with self.bot.session._session.post(
                    f"{self.base}/botfixture/{method}", json=fields
                ) as response:
                    self.assertEqual(response.status, 400)
                    self.assertEqual(response.content_type, "application/json")
                    self.assertFalse((await response.json())["ok"])
                self.assertEqual(self.emulator.requests[-1]["status"], 400)
                self.assertEqual(self.emulator.assets, original_assets)
                self.assertEqual(self.emulator.next_id, original_next)

    async def test_type_named_album_part_cannot_replace_a_missing_reference(self):
        await self.bot.session.create_session()
        for kind in ("photo", "document"):
            form = FormData()
            form.add_field("chat_id", "42")
            form.add_field(
                "media",
                json.dumps(
                    [
                        {"type": kind, "media": "attach://" + kind},
                        {"type": kind, "media": "attach://missing"},
                    ]
                ),
            )
            form.add_field(kind, b"fixture", filename="fixture.bin")
            async with self.bot.session._session.post(
                f"{self.base}/botfixture/sendMediaGroup", data=form
            ) as response:
                self.assertEqual(response.status, 400)
                self.assertFalse((await response.json())["ok"])
            self.assertEqual(self.emulator.assets, {})
            self.assertEqual(self.emulator.next_id, 1)

    async def test_non_object_and_malformed_json_are_refused(self):
        await self.bot.session.create_session()
        for value in ([], "text", None):
            async with self.bot.session._session.post(
                f"{self.base}/botfixture/sendMessage", json=value
            ) as response:
                self.assertEqual(response.status, 400)
        async with self.bot.session._session.post(
            f"{self.base}/botfixture/sendMessage",
            data="{",
            headers={"content-type": "application/json"},
        ) as response:
            self.assertEqual(response.status, 400)
        self.assertEqual(self.emulator.assets, {})

    async def test_duplicate_multipart_fields_and_missing_download_are_refused(self):
        await self.bot.session.create_session()
        form = FormData()
        form.add_field("document", b"one", filename="one.txt")
        form.add_field("document", b"two", filename="two.txt")
        async with self.bot.session._session.post(
            f"{self.base}/botfixture/sendDocument", data=form
        ) as response:
            self.assertEqual(response.status, 400)
        async with self.bot.session._session.get(
            f"{self.base}/file/botfixture/missing"
        ) as response:
            self.assertEqual(response.status, 404)
        self.assertEqual(self.emulator.assets, {})


class EmulatorPolicy(unittest.TestCase):
    def test_valid_targets_and_keyboard_shapes_remain_accepted(self):
        emulator = LoBotApiEmulator()
        for markup in (
            {"inline_keyboard": [[{"text": "Go", "callback_data": "go"}]]},
            {"inline_keyboard": []},
            {"inline_keyboard": [[{"text": "Open", "url": "tg://resolve?domain=fixture"}]]},
            {"inline_keyboard": [[{"text": "App", "web_app": {"url": "https://example.test"}}]]},
            {"inline_keyboard": [[{"text": "Copy", "copy_text": {"text": "copy"}}]]},
            {"inline_keyboard": [[{"text": "Search", "switch_inline_query": ""}]]},
            {"inline_keyboard": [[{"text": "Here", "switch_inline_query_current_chat": ""}]]},
            {"keyboard": [["Go", {"text": "Contact", "request_contact": True}]]},
            {"keyboard": [[{"text": "App", "web_app": {"url": "https://example.test"}}]]},
            {"keyboard": [[{"text": "Location", "request_location": True}]]},
            {"remove_keyboard": True},
        ):
            self.assertEqual(
                emulator.validate(
                    "sendMessage", {"chat_id": 42, "text": "x", "reply_markup": markup}, {}
                )["text"],
                "x",
            )
        original_next = emulator.next_id
        edited = emulator.validate(
            "editMessageText",
            {
                "chat_id": 42,
                "message_id": 2**63 - 1,
                "text": "changed",
            },
            {},
        )
        self.assertEqual(edited["message_id"], 2**63 - 1)
        self.assertEqual(emulator.next_id, original_next)
        self.assertTrue(
            emulator.validate(
                "deleteMessage",
                {
                    "chat_id": -(2**63),
                    "message_id": "1",
                },
                {},
            )
        )
        self.assertTrue(
            emulator.validate("answerCallbackQuery", {"callback_query_id": "opaque"}, {})
        )
        upload = {"filename": "fixture.png", "data": b"fixture", "size": 7}
        for value, expected in [(True, "true"), (1, "1"), (1.5, "1.5")]:
            self.assertEqual(
                emulator.validate(
                    "sendPhoto",
                    {
                        "chat_id": 42,
                        "caption": value,
                    },
                    {"photo": upload},
                )["caption"],
                expected,
            )

    def test_album_errors_never_commit_partial_assets(self):
        upload = {"filename": "fixture.bin", "data": b"fixture", "size": 7}
        media = [{"type": "photo", "media": "attach://a"}, {"type": "photo", "media": "attach://b"}]
        for value in (
            "not-json",
            [],
            [None, None],
            [{**media[0], "unknown": 1}, media[1]],
            [{**media[0], "type": "voice"}, media[1]],
            [media[0], {**media[1], "caption": "second"}],
            [media[0], {**media[1], "media": "attach://missing"}],
        ):
            emulator = LoBotApiEmulator()
            with self.subTest(value=value), self.assertRaises(ApiRefusal):
                emulator.validate(
                    "sendMediaGroup", {"chat_id": 42, "media": value}, {"a": upload, "b": upload}
                )
            self.assertEqual(emulator.assets, {})
            self.assertEqual(emulator.next_id, 1)

    def test_invalid_markup_and_destructive_operations_are_refused(self):
        emulator = LoBotApiEmulator()
        for method, fields in [
            ("sendMessage", {"chat_id": 42, "text": "x", "reply_markup": "{"}),
            ("sendMessage", {"chat_id": 42, "text": "x", "reply_markup": []}),
            ("deleteMessage", {}),
            ("setMyCommands", {"commands": {}}),
            ("getFile", {"file_id": "missing"}),
            ("sendMessage", {"chat_id": True, "text": "x"}),
            ("sendMessage", {"chat_id": 42, "text": "x", "method": "deleteMessage"}),
        ]:
            with self.subTest(method=method), self.assertRaises(ApiRefusal):
                emulator.validate(method, fields, {})
        self.assertEqual(emulator.assets, {})

    def test_upload_limits_and_cached_audio_remain_distinct(self):
        emulator = LoBotApiEmulator()
        oversized = {"filename": "photo.jpg", "data": b"", "size": 11 * 1024 * 1024}
        with self.assertRaises(ApiRefusal):
            emulator.validate("sendPhoto", {"chat_id": 42}, {"photo": oversized})
        upload = {"filename": "audio.aac", "data": b"audio", "size": 5}
        with self.assertRaises(ApiRefusal):
            emulator.validate("sendAudio", {"chat_id": 42}, {"audio": upload})
        emulator.assets["cached-audio"] = upload
        message = emulator.validate(
            "sendAudio", {"chat_id": -42, "audio": "cached-audio", "caption": "Audio"}, {}
        )
        self.assertEqual(message["audio"]["file_id"], "cached-audio")
        self.assertEqual(message["chat"]["type"], "group")
        self.assertEqual(message["caption"], "Audio")

    def test_cli_passes_explicit_contract_mode_and_port(self):
        with (
            patch(
                "sys.argv",
                [
                    "lo-bot-api-emulator",
                    "--port",
                    "9011",
                    "--disable-video-uploads",
                    "--legacy-single-attach",
                ],
            ),
            patch("lo_bot_api_emulator.web.run_app") as run,
        ):
            main()
            self.assertEqual(run.call_args.kwargs, {"host": "0.0.0.0", "port": 9011})
            application = run.call_args.args[0]
            self.assertGreater(len(list(application.router.routes())), 0)
