import unittest
from aiogram.types import FSInputFile, InputMediaDocument, InputMediaPhoto
from test_conformance import Fixture
from lo_bot_api_emulator import ApiRefusal, LoBotApiEmulator
from pathlib import Path
from tempfile import TemporaryDirectory

class AdapterEdges(Fixture):
    async def test_filesystem_reply_video_upload_and_thumbnail(self):
        with TemporaryDirectory() as directory:
            video, thumbnail = Path(directory)/'video.mp4', Path(directory)/'poster.jpg'
            video.write_bytes(b'fixture video')
            thumbnail.write_bytes(b'fixture thumbnail')
            first = await self.bot.send_message(42, 'Reply fixture')
            result = await first.reply_video(FSInputFile(video), thumbnail=FSInputFile(thumbnail), duration=1)
            self.assertIsNotNone(result.video)
            self.assertEqual(self.emulator.requests[-1]['files'], ['thumbnail', 'video'])
            self.assertEqual(self.emulator.requests[-1]['status'], 200)

    async def test_mixed_photo_document_album_keeps_order(self):
        result = await self.bot.send_media_group(42, [InputMediaPhoto(media=self.upload('photo.png')), InputMediaDocument(media=self.upload('doc.txt'))])
        self.assertIsNotNone(result[0].photo)
        self.assertIsNotNone(result[1].document)

    async def test_secretary_context_is_not_downgraded_to_ordinary_send(self):
        with self.assertRaisesRegex(ValueError, 'consent context'):
            await self.bot.send_message(42, 'Private', business_connection_id='connection')
        self.assertEqual(self.emulator.requests, [])

    async def test_warning_once_and_reset_after_installation_change(self):
        with self.assertLogs('lo_aiogram', 'WARNING') as logs:
            await self.bot.send_message(42, 'First', disable_notification=True)
            await self.bot.send_message(42, 'Second', disable_notification=True)
        self.assertEqual(sum('disable_notification' in entry for entry in logs.output), 1)
        self.emulator.video_uploads = False
        await self.bot.send_video(42, self.upload())
        self.assertTrue(self.compat.video_disabled)
        self.compat.reset(self.bot)
        self.assertEqual(self.compat.video_disabled, {})
        self.emulator.video_uploads = True
        self.assertIsNotNone((await self.bot.send_video(42, self.upload())).video)

    async def test_installation_flags_are_refreshed_without_failed_video_probes(self):
        self.compat.probe_capabilities = True
        self.emulator.video_uploads = False
        result = await self.bot.send_video(42, self.upload())
        self.assertIsNotNone(result.document)
        self.assertEqual([row['method'] for row in self.emulator.requests], ['getMe','sendDocument'])
        self.emulator.video_uploads = True
        self.clock = 301
        result = await self.bot.send_video(42, self.upload())
        self.assertIsNotNone(result.video)
        self.assertEqual([row['method'] for row in self.emulator.requests[-2:]], ['getMe','sendVideo'])
        self.assertTrue(all(row['status']==200 for row in self.emulator.requests))

    async def test_structured_failure_does_not_depend_on_description(self):
        from lo_bot_api_emulator import ApiRefusal
        original = self.emulator.validate
        def refuse(method, fields, uploads):
            if method == 'sendMessage' and 'parse_mode' in fields:
                raise ApiRefusal('Readable text can change', parameters={'reason':'unsupported_parameter','parameter':'parse_mode'})
            return original(method,fields,uploads)
        self.emulator.validate = refuse
        result = await self.bot.send_message(42,'Fixture',parse_mode='HTML')
        self.assertEqual(result.text,'Fixture')
        self.assertEqual(len(self.emulator.requests),2)

class StrictRefusals(unittest.TestCase):
    def test_invalid_chat_caption_metadata_and_no_partial_album_commit(self):
        emulator = LoBotApiEmulator()
        small = {'filename':'a.png','data':b'a','size':1}
        large = {'filename':'b.png','data':b'b','size':11*1024*1024}
        for method, fields, uploads in [
            ('sendMessage', {'chat_id':0,'text':'x'}, {}),
            ('sendMessage', {'chat_id':42,'text':'😀'*2049}, {}),
            ('sendVideo', {'chat_id':42,'width':16385}, {'video':small}),
            ('sendPhoto', {'chat_id':42,'reply_markup':{'keyboard':[['x']]}}, {'photo':small}),
            ('sendMediaGroup', {'chat_id':42,'media':[{'type':'photo','media':'attach://a'}, {'type':'photo','media':'attach://b'}]}, {'a':small,'b':large}),
        ]:
            with self.subTest(method=method):
                with self.assertRaises(ApiRefusal):
                    emulator.validate(method, fields, uploads)
                self.assertEqual(emulator.assets, {})
                self.assertEqual(emulator.next_id, 1)


class DocumentAlbumConformance(unittest.TestCase):
    def test_duplicate_cached_documents_are_refused_before_committing_an_album(self):
        emulator = LoBotApiEmulator()
        upload = {"filename": "a.txt", "data": b"fixture", "size": 7}
        first = emulator.validate("sendDocument", {"chat_id": 42}, {"document": upload})["document"]["file_id"]
        second = emulator.validate("sendDocument", {"chat_id": 42}, {"document": upload})["document"]["file_id"]
        next_id = emulator.next_id
        with self.assertRaises(ApiRefusal) as refused:
            emulator.validate("sendMediaGroup", {"chat_id": 42, "media": [{"type": "document", "media": first}, {"type": "document", "media": first}]}, {})
        self.assertEqual(refused.exception.status, 400)
        self.assertEqual(emulator.next_id, next_id)
        accepted = emulator.validate("sendMediaGroup", {"chat_id": 42, "media": [{"type": "document", "media": first}, {"type": "document", "media": second}]}, {})
        self.assertEqual(len(accepted), 2)

class CachedVideoRefusalFallback(Fixture):
    async def test_cached_video_structured_refusal_retries_once_and_remembers_field(self):
        uploaded = await self.bot.send_video(42, self.upload())
        validate = self.emulator.validate
        def reject(method, fields, uploads):
            if method == 'sendVideo' and 'parse_mode' in fields:
                raise ApiRefusal('Readable text changed', parameters={'reason': 'unsupported_parameter', 'parameter': 'parse_mode'})
            return validate(method, fields, uploads)
        self.emulator.validate = reject
        start = len(self.emulator.requests)
        result = await self.bot.send_video(42, uploaded.video.file_id, caption='Fixture', parse_mode='HTML')
        self.assertIsNotNone(result.video)
        self.assertEqual([r['status'] for r in self.emulator.requests[start:]], [400, 200])
        self.assertTrue(all(r['files'] == [] for r in self.emulator.requests[start:]))
        await self.bot.send_video(42, uploaded.video.file_id, caption='Fixture', parse_mode='HTML')
        self.assertEqual(len(self.emulator.requests), start + 3)
        self.assertNotIn('parse_mode', self.emulator.requests[-1]['fields'])

    async def test_cached_video_second_field_refusal_propagates_without_retry_loop(self):
        from aiogram.exceptions import TelegramBadRequest
        uploaded = await self.bot.send_video(42, self.upload())
        validate = self.emulator.validate
        def reject(method, fields, uploads):
            if method == 'sendVideo':
                field = 'parse_mode' if 'parse_mode' in fields else 'supports_streaming'
                raise ApiRefusal('Readable text changed', parameters={'reason': 'unsupported_parameter', 'parameter': field})
            return validate(method, fields, uploads)
        self.emulator.validate = reject
        start = len(self.emulator.requests)
        with self.assertRaises(TelegramBadRequest):
            await self.bot.send_video(42, uploaded.video.file_id, parse_mode='HTML', supports_streaming=True)
        self.assertEqual([r['status'] for r in self.emulator.requests[start:]], [400, 400])
        self.assertTrue(all(r['files'] == [] for r in self.emulator.requests[start:]))

    async def test_video_upload_structured_field_refusal_is_not_replayed(self):
        from aiogram.exceptions import TelegramBadRequest
        validate = self.emulator.validate
        def reject(method, fields, uploads):
            if method == 'sendVideo':
                raise ApiRefusal('Readable text changed', parameters={'reason': 'unsupported_parameter', 'parameter': 'parse_mode'})
            return validate(method, fields, uploads)
        self.emulator.validate = reject
        with self.assertRaises(TelegramBadRequest):
            await self.bot.send_video(42, self.upload(), parse_mode='HTML')
        self.assertEqual(len(self.emulator.requests), 1)
        self.assertEqual(self.emulator.requests[0]['files'], ['video'])
        self.assertEqual(self.emulator.assets, {})

    async def test_cached_video_server_failure_is_not_retried(self):
        from aiogram.exceptions import TelegramServerError
        uploaded = await self.bot.send_video(42, self.upload())
        validate = self.emulator.validate
        def reject(method, fields, uploads):
            if method == 'sendVideo':
                raise ApiRefusal('Unavailable', 503)
            return validate(method, fields, uploads)
        self.emulator.validate = reject
        start = len(self.emulator.requests)
        with self.assertRaises(TelegramServerError):
            await self.bot.send_video(42, uploaded.video.file_id, parse_mode='HTML')
        self.assertEqual(len(self.emulator.requests), start + 1)
