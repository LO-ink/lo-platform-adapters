import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from aiogram.exceptions import TelegramBadRequest
from aiogram.types import FSInputFile, InputMediaDocument, InputMediaPhoto
from lo_bot_api_emulator import ApiRefusal, LoBotApiEmulator
from test_conformance import Fixture


class AdapterEdges(Fixture):
    async def test_filesystem_video_upload_and_thumbnail(self):
        with TemporaryDirectory() as directory:
            video, thumbnail = Path(directory) / "video.mp4", Path(directory) / "poster.jpg"
            video.write_bytes(b"fixture video")
            thumbnail.write_bytes(b"fixture thumbnail")
            result = await self.bot.send_video(
                42, FSInputFile(video), thumbnail=FSInputFile(thumbnail), duration=1
            )
            self.assertIsNotNone(result.video)
            self.assertEqual(self.emulator.requests[-1]["files"], ["thumbnail", "video"])

    async def test_mixed_photo_document_album_is_rejected_without_partial_delivery(self):
        with self.assertRaises(TelegramBadRequest):
            await self.bot.send_media_group(
                42,
                [
                    InputMediaPhoto(media=self.upload("photo.png")),
                    InputMediaDocument(media=self.upload("doc.txt")),
                ],
            )
        self.assertEqual(len(self.emulator.requests), 1)
        self.assertEqual(self.emulator.assets, {})

    async def test_secretary_context_is_not_downgraded_to_ordinary_send(self):
        with self.assertRaisesRegex(ValueError, "consent context"):
            await self.bot.send_message(42, "Private", business_connection_id="connection")
        self.assertEqual(self.emulator.requests, [])


class StrictRefusals(unittest.TestCase):
    def test_invalid_chat_caption_metadata_and_no_partial_album_commit(self):
        emulator = LoBotApiEmulator()
        small = {"filename": "a.png", "data": b"a", "size": 1}
        large = {"filename": "b.png", "data": b"b", "size": 11 * 1024 * 1024}
        for method, fields, uploads in [
            ("sendMessage", {"chat_id": 0, "text": "x"}, {}),
            ("sendMessage", {"chat_id": 42, "text": "😀" * 2049}, {}),
            ("sendVideo", {"chat_id": 42, "width": 16385}, {"video": small}),
            ("sendPhoto", {"chat_id": 42, "reply_markup": {"keyboard": [["x"]]}}, {"photo": small}),
            (
                "sendMediaGroup",
                {
                    "chat_id": 42,
                    "media": [
                        {"type": "photo", "media": "attach://a"},
                        {"type": "photo", "media": "attach://b"},
                    ],
                },
                {"a": small, "b": large},
            ),
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
        first = emulator.validate("sendDocument", {"chat_id": 42}, {"document": upload})[
            "document"
        ]["file_id"]
        second = emulator.validate("sendDocument", {"chat_id": 42}, {"document": upload})[
            "document"
        ]["file_id"]
        next_id = emulator.next_id
        with self.assertRaises(ApiRefusal) as refused:
            emulator.validate(
                "sendMediaGroup",
                {
                    "chat_id": 42,
                    "media": [
                        {"type": "document", "media": first},
                        {"type": "document", "media": first},
                    ],
                },
                {},
            )
        self.assertEqual(refused.exception.status, 400)
        self.assertEqual(emulator.next_id, next_id)
        accepted = emulator.validate(
            "sendMediaGroup",
            {
                "chat_id": 42,
                "media": [
                    {"type": "document", "media": first},
                    {"type": "document", "media": second},
                ],
            },
            {},
        )
        self.assertEqual(len(accepted), 2)
