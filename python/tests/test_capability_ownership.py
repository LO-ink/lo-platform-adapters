"""Deterministic middleware schedules with real aiogram methods and identities."""
import asyncio
import unittest

from aiogram import Bot
from aiogram.methods import GetMe, SendVideo
from aiogram.types import BufferedInputFile, User
from lo_aiogram import LoAiohttpSession, LoBotApiCompat


class CapabilityOwnership(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.clock = 100
        self.compat = LoBotApiCompat(clock=lambda: self.clock)
        self.bot = self.new_bot('A')
        self.pending = []
        self.sent = []

    def new_bot(self, credential):
        session = LoAiohttpSession(compatibility=False)
        self.addAsyncCleanup(session.close)
        return Bot('123456:' + credential * 43, session=session)

    @staticmethod
    def identity(enabled):
        return User(id=123456, is_bot=True, first_name='Fixture', capabilities={'video_uploads': enabled})

    async def request(self, bot, method):
        if isinstance(method, GetMe):
            future = asyncio.get_running_loop().create_future()
            self.pending.append(future)
            return await future
        self.sent.append(method.__api_method__)
        return method.__api_method__

    async def start(self, method=None, bot=None):
        task = asyncio.create_task(self.compat(self.request, bot or self.bot, method or GetMe()))
        await asyncio.sleep(0)
        return task

    def upload(self):
        return SendVideo(chat_id=42, video=BufferedInputFile(b'fixture', filename='video.mp4'))

    async def finish(self, task, index, enabled):
        self.pending[index].set_result(self.identity(enabled))
        return await task

    async def test_late_disabled_identity_cannot_undo_newer_enabled_refresh(self):
        old, new = await self.start(), await self.start()
        self.assertEqual((await self.finish(new, 1, True)).capabilities, {'video_uploads': True})
        self.clock = 120
        self.assertEqual((await self.finish(old, 0, False)).capabilities, {'video_uploads': False})
        self.assertEqual(await self.compat(self.request, self.bot, self.upload()), 'sendVideo')
        self.assertEqual(self.compat.next_capability_check[self.compat.scope(self.bot)], 400)
        self.assertEqual(len(self.pending), 2)

    async def test_late_enabled_identity_cannot_undo_newer_disabled_refresh(self):
        old, new = await self.start(), await self.start()
        await self.finish(new, 1, False)
        await self.finish(old, 0, True)
        self.assertEqual(await self.compat(self.request, self.bot, self.upload()), 'sendDocument')

    async def test_automatic_probe_and_explicit_refresh_share_ownership(self):
        old = await self.start(self.upload())
        new = await self.start()
        await self.finish(new, 1, True)
        self.assertEqual(await self.finish(old, 0, False), 'sendVideo')
        self.assertEqual(self.sent, ['sendVideo'])

    async def test_failed_refresh_preserves_cache_and_fences_older_success(self):
        established = await self.start()
        await self.finish(established, 0, False)
        old, new = await self.start(), await self.start()
        self.clock = 150
        self.pending[2].set_exception(ValueError('invalid identity response'))
        with self.assertRaisesRegex(ValueError, 'invalid identity'):
            await new
        await self.finish(old, 1, True)
        scope = self.compat.scope(self.bot)
        self.assertEqual(self.compat.next_capability_check[scope], 400)
        self.assertEqual(self.compat.video_disabled[scope], 400)
        self.assertEqual(await self.compat(self.request, self.bot, self.upload()), 'sendDocument')

    async def test_reset_invalidates_pending_response_and_next_video_probes(self):
        old = await self.start()
        self.compat.reset(self.bot)
        await self.finish(old, 0, False)
        scope = self.compat.scope(self.bot)
        self.assertNotIn(scope, self.compat.next_capability_check)
        self.assertNotIn(scope, self.compat.video_disabled)
        video = await self.start(self.upload())
        self.assertEqual(await self.finish(video, 1, True), 'sendVideo')

    async def test_reset_and_new_request_cannot_reuse_old_ownership(self):
        old = await self.start()
        self.compat.reset(self.bot)
        new = await self.start()
        await self.finish(new, 1, True)
        await self.finish(old, 0, False)
        self.assertEqual(await self.compat(self.request, self.bot, self.upload()), 'sendVideo')

    async def test_same_bot_id_with_different_credentials_is_independent(self):
        other = self.new_bot('B')
        old, new = await self.start(), await self.start(bot=other)
        await self.finish(new, 1, True)
        await self.finish(old, 0, False)
        self.assertEqual(await self.compat(self.request, self.bot, self.upload()), 'sendDocument')
        self.assertEqual(await self.compat(self.request, other, self.upload()), 'sendVideo')
        self.compat.reset(other)
        self.assertIn(self.compat.scope(self.bot), self.compat.video_disabled)

    async def test_cancelled_refresh_fences_old_response_without_changing_cache(self):
        established = await self.start()
        await self.finish(established, 0, False)
        old, new = await self.start(), await self.start()
        new.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await new
        await self.finish(old, 1, True)
        self.assertEqual(await self.compat(self.request, self.bot, self.upload()), 'sendDocument')

    async def test_task_cancelled_before_start_does_not_take_ownership(self):
        old = await self.start()
        cancelled = asyncio.create_task(self.compat(self.request, self.bot, GetMe()))
        cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled
        await self.finish(old, 0, False)
        self.assertEqual(len(self.pending), 1)
        self.assertEqual(await self.compat(self.request, self.bot, self.upload()), 'sendDocument')
