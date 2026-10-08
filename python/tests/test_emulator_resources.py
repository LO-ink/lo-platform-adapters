import json
import unittest
from unittest.mock import patch

from aiohttp import ClientSession, FormData, web
from lo_bot_api_emulator import ApiRefusal, LoBotApiEmulator, main


class EmulatorResources(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.emulator = LoBotApiEmulator(request_bytes=2048, asset_bytes=256, max_history=3)
        self.application = self.emulator.app()
        runner = web.AppRunner(self.application)
        await runner.setup()
        self.addAsyncCleanup(runner.cleanup)
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        self.base = f"http://127.0.0.1:{runner.addresses[0][1]}"
        self.session = ClientSession()
        self.addAsyncCleanup(self.session.close)

    async def test_fixed_and_chunked_multipart_are_bounded_in_aggregate(self):
        self.application._client_max_size = 256
        media = json.dumps(
            [
                {"type": "document", "media": "attach://a"},
                {"type": "document", "media": "attach://b"},
            ]
        )
        body = b""
        for name, data, filename in [
            ("chat_id", b"42", None),
            ("media", media.encode(), None),
            ("a", b"A" * 192, "a.bin"),
            ("b", b"B" * 192, "b.bin"),
        ]:
            header = f'--fixture\r\nContent-Disposition: form-data; name="{name}"'
            if filename:
                header += f'; filename="{filename}"'
            body += (header + "\r\n\r\n").encode() + data + b"\r\n"
        body += b"--fixture--\r\n"

        async def chunks():
            for offset in range(0, len(body), 64):
                yield body[offset : offset + 64]

        for data in [body, chunks()]:
            async with self.session.post(
                self.base + "/botfixture/sendMediaGroup",
                data=data,
                headers={"content-type": "multipart/form-data; boundary=fixture"},
            ) as response:
                self.assertEqual(response.status, 413)
                self.assertFalse((await response.json())["ok"])
            self.assertEqual(self.emulator.assets, {})
            self.assertEqual(self.emulator.next_id, 1)

    async def test_part_count_and_json_body_limits_return_json_refusals(self):
        self.emulator.max_parts = 2
        form = FormData()
        form.add_field("chat_id", "42")
        form.add_field("text", "x")
        form.add_field("document", b"x", filename="x.bin")
        async with self.session.post(self.base + "/botfixture/sendDocument", data=form) as response:
            self.assertEqual(response.status, 413)
            self.assertFalse((await response.json())["ok"])
        self.application._client_max_size = 32
        async with self.session.post(
            self.base + "/botfixture/sendMessage", json={"chat_id": 42, "text": "x" * 100}
        ) as response:
            self.assertEqual(response.status, 413)
            self.assertFalse((await response.json())["ok"])
        self.assertEqual(self.emulator.next_id, 1)

    async def test_asset_capacity_preserves_existing_downloads_and_identifiers(self):
        self.emulator.max_assets = 1
        form = FormData()
        form.add_field("chat_id", "42")
        form.add_field("document", b"existing", filename="old.bin")
        async with self.session.post(self.base + "/botfixture/sendDocument", data=form) as response:
            self.assertEqual(response.status, 200)
            reference = (await response.json())["result"]["document"]["file_id"]
        next_id = self.emulator.next_id
        form = FormData()
        form.add_field("chat_id", "42")
        form.add_field("document", b"incoming", filename="new.bin")
        async with self.session.post(self.base + "/botfixture/sendDocument", data=form) as response:
            self.assertEqual(response.status, 507)
            self.assertFalse((await response.json())["ok"])
        self.assertEqual(self.emulator.next_id, next_id)
        self.assertEqual(list(self.emulator.assets), [reference])
        async with self.session.get(self.base + "/file/botfixture/" + reference) as response:
            self.assertEqual(await response.read(), b"existing")

    async def test_history_keeps_a_bounded_recent_suffix(self):
        for method in ["getMe", "getUpdates", "getMyCommands", "getMe", "getUpdates"]:
            async with self.session.post(self.base + "/botfixture/" + method, json={}) as response:
                self.assertEqual(response.status, 200)
        self.assertEqual(
            [r["method"] for r in self.emulator.requests], ["getMyCommands", "getMe", "getUpdates"]
        )


class EmulatorBudgetPolicy(unittest.TestCase):
    def test_album_capacity_is_reserved_before_any_asset_commit(self):
        emulator = LoBotApiEmulator(asset_bytes=3)
        upload = {"filename": "fixture.bin", "data": b"xx", "size": 2}
        media = [
            {"type": "document", "media": "attach://a"},
            {"type": "document", "media": "attach://b"},
        ]
        with self.assertRaises(ApiRefusal) as caught:
            emulator.validate(
                "sendMediaGroup", {"chat_id": 42, "media": media}, {"a": upload, "b": upload}
            )
        self.assertEqual(caught.exception.status, 507)
        self.assertEqual(emulator.assets, {})
        self.assertEqual(emulator.next_id, 1)

    def test_resource_configuration_rejects_invalid_limits(self):
        for name in ["request_bytes", "asset_bytes", "max_assets", "max_history", "max_parts"]:
            for value in [0, -1, True, 0.5]:
                with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                    LoBotApiEmulator(**{name: value})

    def test_container_network_binding_requires_explicit_host(self):
        with (
            patch("sys.argv", ["lo-bot-api-emulator", "--host", "0.0.0.0"]),
            patch("lo_bot_api_emulator.web.run_app") as run,
        ):
            main()
        self.assertEqual(run.call_args.kwargs["host"], "0.0.0.0")
