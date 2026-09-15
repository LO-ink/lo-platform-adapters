import io
import json
import unittest

from aiohttp import web
from aiogram import Bot
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.exceptions import (
    TelegramConflictError,
    TelegramNotFound,
    TelegramRetryAfter,
    TelegramServerError,
    TelegramUnauthorizedError,
)
from aiogram.types import BotCommand, BufferedInputFile

TOKEN = "123456:lo-fixture-ABCDEFGHIJKLMNOPQRSTUVWXYZ"


class ClientContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.requests = []
        self.response = {"ok": True, "result": True}
        self.status = 200
        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", self.handle)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        self.addAsyncCleanup(self.runner.cleanup)
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.base = f"http://127.0.0.1:{self.runner.addresses[0][1]}"
        self.bot = Bot(
            token=TOKEN,
            session=AiohttpSession(api=TelegramAPIServer.from_base(self.base), timeout=2),
        )
        self.addAsyncCleanup(self.bot.session.close)

    async def handle(self, request):
        self.requests.append((request.method, request.content_type))
        if request.path.startswith(f"/file/bot{TOKEN}/"):
            self.calls.append((request.path, None))
            return web.Response(body=b"fixture-image")
        data = await request.post()
        fields = {}
        for name, value in data.items():
            if isinstance(value, web.FileField):
                fields[name] = {"filename": value.filename, "bytes": value.file.read()}
            else:
                fields[name] = value
        self.calls.append((request.path, fields))
        return web.json_response(self.response, status=self.status)

    def result(self, result):
        self.response = {"ok": True, "result": result}

    async def test_identity_commands_and_exact_routes(self):
        self.result({"id": 7, "is_bot": True, "first_name": "Fixture"})
        self.assertEqual((await self.bot.get_me()).id, 7)
        self.assertEqual(self.calls[-1][0], f"/bot{TOKEN}/getMe")
        self.assertEqual(self.requests[-1][0], "POST")
        self.result(True)
        await self.bot.set_my_commands([BotCommand(command="start", description="Start")])
        self.assertEqual(self.calls[-1][0], f"/bot{TOKEN}/setMyCommands")
        self.assertEqual(self.requests[-1], ("POST", "application/x-www-form-urlencoded"))
        self.assertEqual(json.loads(self.calls[-1][1]["commands"]), [{"command": "start", "description": "Start"}])

    async def test_multipart_upload(self):
        self.result({"message_id": 1, "date": 1, "chat": {"id": 99, "type": "private"}})
        await self.bot.send_photo(99, BufferedInputFile(b"fixture-image", filename="sample.png"))
        path, fields = self.calls[-1]
        self.assertEqual(path, f"/bot{TOKEN}/sendPhoto")
        self.assertEqual(self.requests[-1], ("POST", "multipart/form-data"))
        self.assertEqual(fields["chat_id"], "99")
        attachment = fields["photo"].removeprefix("attach://")
        self.assertEqual(fields[attachment], {"filename": "sample.png", "bytes": b"fixture-image"})

    async def test_file_metadata_and_download_root(self):
        self.result({"file_id": "asset", "file_unique_id": "asset-unique", "file_path": "photos/asset.png"})
        metadata = await self.bot.get_file("asset")
        self.assertEqual(self.requests[-1], ("POST", "application/x-www-form-urlencoded"))
        output = io.BytesIO()
        await self.bot.download_file(metadata.file_path, destination=output)
        self.assertEqual(output.getvalue(), b"fixture-image")
        self.assertEqual(self.calls[-1][0], f"/file/bot{TOKEN}/photos/asset.png")
        self.assertEqual(self.requests[-1][0], "GET")

    async def test_typed_errors_and_retry_guidance_without_implicit_retry(self):
        for status, error_type in [(401, TelegramUnauthorizedError), (404, TelegramNotFound), (409, TelegramConflictError), (429, TelegramRetryAfter), (501, TelegramServerError)]:
            with self.subTest(status=status):
                self.status = status
                self.response = {"ok": False, "error_code": status, "description": "fixture failure"}
                if status == 429:
                    self.response["parameters"] = {"retry_after": 9}
                before = len(self.calls)
                with self.assertRaises(error_type) as caught:
                    await self.bot.get_me()
                self.assertEqual(len(self.calls), before + 1)
                if status == 429:
                    self.assertEqual(caught.exception.retry_after, 9)


if __name__ == "__main__":
    unittest.main()
