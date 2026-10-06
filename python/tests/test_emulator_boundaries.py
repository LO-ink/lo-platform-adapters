import unittest
from unittest.mock import patch

from aiohttp import FormData
from lo_bot_api_emulator import ApiRefusal, LoBotApiEmulator, main
from test_conformance import Fixture


class EmulatorRequestBoundaries(Fixture):
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
