"""Exercise the default command of an already-built emulator image; never publish it."""

import argparse
import asyncio
import json
import subprocess
import time
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.exceptions import TelegramNetworkError
from aiogram.filters import CommandStart
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup
from aiohttp import ClientSession
from lo_aiogram import LoAiohttpSession
from lo_aiogram.compat import LoBotCompat


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, timeout=60).strip()


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


async def check_bot(image_id):
    container = docker(
        "create",
        "--publish",
        "127.0.0.1::8080",
        image_id,
        "lo-bot-api-emulator",
        "--host",
        "0.0.0.0",
        "--enable-control",
        "--journal",
        "/home/emulator/requests.jsonl",
    )
    try:
        docker("start", container)
        port = json.loads(docker("inspect", container))[0]["NetworkSettings"]["Ports"]["8080/tcp"][
            0
        ]["HostPort"]
        base, token = "http://127.0.0.1:" + port, "123456:" + "A" * 43
        bot = Bot(
            token, session=LoAiohttpSession(base_url=base, allow_insecure_loopback=True, timeout=3)
        )
        try:
            for _ in range(100):
                try:
                    await bot.get_me()
                    break
                except TelegramNetworkError:
                    await asyncio.sleep(0.1)
            else:
                raise RuntimeError("Configured fixture did not become ready")
            bot.session.middleware(LoBotCompat())
            dispatcher, handled = Dispatcher(), asyncio.Event()

            @dispatcher.message(CommandStart())
            async def start(message):
                await message.reply(
                    "Choose",
                    disable_notification=True,
                    reply_markup=InlineKeyboardMarkup(
                        inline_keyboard=[[InlineKeyboardButton(text="RU", callback_data="ru")]]
                    ),
                )
                handled.set()

            @dispatcher.callback_query(F.data == "ru")
            async def button(query):
                await query.message.edit_reply_markup(
                    reply_markup=InlineKeyboardMarkup(inline_keyboard=[])
                )
                await query.answer()
                handled.set()

            polling = asyncio.create_task(
                dispatcher.start_polling(
                    bot, handle_signals=False, close_bot_session=False, polling_timeout=1
                )
            )
            message = {
                "message_id": 10,
                "date": 1,
                "chat": {"id": 42, "type": "private"},
                "from": {"id": 42, "is_bot": False, "first_name": ""},
                "text": "/start",
            }
            try:
                async with ClientSession() as client:
                    for update in [
                        {"message": message},
                        {
                            "callback_query": {
                                "id": "button",
                                "from": message["from"],
                                "chat_instance": "chat",
                                "message": message,
                                "data": "ru",
                            }
                        },
                    ]:
                        handled.clear()
                        async with client.post(
                            base + "/__fixture/updates", json={"token": token, "update": update}
                        ) as response:
                            check(response.status == 200, "Synthetic update enqueue failed")
                        await asyncio.wait_for(handled.wait(), 5)
            finally:
                await dispatcher.stop_polling()
                await asyncio.wait_for(polling, 5)
            receipt = json.loads(
                docker(
                    "exec",
                    container,
                    "lo-bot-api-emulator",
                    "verdict",
                    "/home/emulator/requests.jsonl",
                    "--require-response",
                    "--require-method",
                    "editMessageReplyMarkup",
                    "--require-method",
                    "answerCallbackQuery",
                )
            )
            check(receipt["ok"] is True, "Container bot journal verdict failed")
            log = docker("logs", container)
            check(token not in log and "Choose" not in log, "Container logs leaked request data")
            return receipt
        finally:
            await bot.session.close()
    finally:
        docker("rm", "--force", container)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument(
        "--version",
        default=tomllib.loads(
            (
                Path(__file__).resolve().parent.parent / "python/lo-bot-api-emulator/pyproject.toml"
            ).read_text()
        )["project"]["version"],
    )
    args = parser.parse_args()
    image_id = docker("image", "inspect", "--format", "{{.Id}}", args.image)
    container = docker("create", "--publish", "127.0.0.1::8080", image_id)
    try:
        docker("start", container)
        binding = json.loads(docker("inspect", container))[0]["NetworkSettings"]["Ports"][
            "8080/tcp"
        ]
        check(
            len(binding) == 1 and binding[0]["HostIp"] == "127.0.0.1",
            "Container must bind loopback only",
        )
        base = "http://127.0.0.1:" + binding[0]["HostPort"] + "/bot123456:" + "A" * 43 + "/"

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def post(method, fields):
            request = urllib.request.Request(
                base + method,
                data=json.dumps(fields).encode(),
                headers={"Content-Type": "application/json"},
            )
            try:
                response = opener.open(request, timeout=2)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, json.load(response)

        deadline = time.monotonic() + 30
        while True:
            try:
                status, identity = post("getMe", {})
                break
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                check(
                    json.loads(docker("inspect", container))[0]["State"]["Running"],
                    "Default container command exited before readiness",
                )
                check(time.monotonic() < deadline, "Default container command did not become ready")
                time.sleep(0.2)
        check(status == 200 and identity.get("ok") is True, "getMe must succeed")
        result = identity["result"]
        check(
            result["id"] == 7
            and result["is_bot"] is True
            and result["capabilities"]["chat_actions"] is False,
            "Synthetic identity/capabilities mismatch",
        )
        status, invalid = post(
            "sendMessage",
            {"chat_id": 7, "text": "synthetic smoke", "unsupported_smoke_field": True},
        )
        check(
            status == 400
            and invalid.get("ok") is False
            and invalid.get("error_code") == 400
            and invalid.get("parameters", {}).get("parameter") == "unsupported_smoke_field",
            "Unknown parameters must be refused",
        )
        status, stub = post("sendChatAction", {"chat_id": 7, "action": "typing"})
        check(
            status == 501 and stub.get("ok") is False and stub.get("error_code") == 501,
            "Stubbed methods must be refused",
        )
        runtime = json.loads(
            docker(
                "exec",
                container,
                "python",
                "-c",
                "import os,json,importlib.metadata; print(json.dumps({'uid':os.getuid(),'version':importlib.metadata.version('lo-bot-api-emulator')}))",
            )
        )
        check(runtime["uid"] == 10001, "Emulator must run as the dedicated non-root user")
        check(runtime["version"] == args.version, "Installed emulator version mismatch")
        check(
            json.loads(docker("inspect", container))[0]["State"]["Running"],
            "Container exited during smoke",
        )
        bot_receipt = asyncio.run(check_bot(image_id))
        print(
            json.dumps(
                {
                    "image_id": image_id,
                    **runtime,
                    "bot_journal": bot_receipt,
                    "checks": [
                        "default-command",
                        "loopback-only",
                        "synthetic-identity",
                        "invalid-parameter-400",
                        "stub-501",
                        "non-root",
                        "installed-version",
                        "real-aiogram-polling-reply",
                        "callback-and-keyboard-edit",
                        "disk-journal-cli-verdict",
                    ],
                },
                sort_keys=True,
            )
        )
    finally:
        docker("rm", "--force", container)


if __name__ == "__main__":
    main()
