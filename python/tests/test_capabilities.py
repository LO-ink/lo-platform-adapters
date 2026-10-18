import asyncio
from unittest.mock import AsyncMock

from aiogram.exceptions import TelegramBadRequest
from aiogram.types import User
from lo_aiogram import capabilities
from lo_aiogram.capabilities import invalidate_capabilities
from test_conformance import Fixture


class Capabilities(Fixture):
    async def test_cached_copies_are_per_bot_and_refresh_is_explicit(self):
        first = await capabilities(self.bot)
        first["video_uploads"] = False
        self.assertTrue((await capabilities(self.bot))["video_uploads"])
        self.assertEqual(len(self.emulator.requests), 1)
        self.emulator.video_uploads = False
        self.assertFalse((await capabilities(self.bot, refresh=True))["video_uploads"])
        other = self.new_bot()
        self.assertFalse((await capabilities(other))["video_uploads"])
        self.assertEqual(len(self.emulator.requests), 3)

    async def test_feature_refusal_invalidates_even_strict_session(self):
        self.assertTrue((await capabilities(self.bot))["video_uploads"])
        self.emulator.video_uploads = False
        with self.assertRaises(TelegramBadRequest):
            await self.bot.send_video(42, self.upload())
        self.assertFalse((await capabilities(self.bot))["video_uploads"])
        self.assertEqual(
            [row["method"] for row in self.emulator.requests], ["getMe", "sendVideo", "getMe"]
        )

    async def test_simultaneous_reads_coalesce(self):
        results = await asyncio.gather(*(capabilities(self.bot) for _ in range(5)))
        self.assertEqual(len(self.emulator.requests), 1)
        self.assertTrue(all(result == results[0] for result in results))

    async def test_invalidation_and_refresh_fence_older_results(self):
        old, new = asyncio.Future(), asyncio.Future()
        self.bot.get_me = fetch_identity = AsyncMock()
        gates = [old, new]

        async def identity():
            return await gates.pop(0)

        fetch_identity.side_effect = identity
        pending = asyncio.create_task(capabilities(self.bot))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        invalidate_capabilities(self.bot)
        fresh = asyncio.create_task(capabilities(self.bot, refresh=True))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        new.set_result(
            User(
                id=7,
                is_bot=True,
                first_name="",
                capabilities={"video_uploads": False, "unknown": "yes"},
            )
        )
        self.assertEqual(await fresh, {"video_uploads": False})
        old.set_result(User(id=7, is_bot=True, first_name="", capabilities={"video_uploads": True}))
        self.assertEqual(await pending, {"video_uploads": True})
        self.assertEqual(await capabilities(self.bot), {"video_uploads": False})

    async def test_failed_or_missing_capabilities_are_not_invented(self):
        self.bot.get_me = AsyncMock(
            side_effect=[RuntimeError("failed"), User(id=7, is_bot=True, first_name="")]
        )
        with self.assertRaises(RuntimeError):
            await capabilities(self.bot)
        self.assertEqual(await capabilities(self.bot), {})
