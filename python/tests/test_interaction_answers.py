"""Modeled payload parity with messenger inline.ValidateAnswer/callbacks.ValidateAnswer."""

import json
import tempfile
from pathlib import Path

from aiogram.exceptions import TelegramBadRequest
from aiogram.types import (
    InlineQueryResultArticle,
    InlineQueryResultCachedAudio,
    InputTextMessageContent,
)
from aiohttp import ClientSession
from lo_bot_api_emulator import ApiRefusal
from lo_bot_api_emulator.journal import verdict
from test_conformance import TOKEN, Fixture

ARTICLE = {
    "type": "article",
    "id": "a",
    "title": "Title",
    "input_message_content": {"message_text": "Hello"},
}


class InteractionAnswers(Fixture):
    def inline(self, results, **fields):
        return self.emulator.validate(
            "answerInlineQuery", {"inline_query_id": "query", "results": results, **fields}, {}
        )

    def callback(self, **fields):
        return self.emulator.validate(
            "answerCallbackQuery", {"callback_query_id": "query", **fields}, {}
        )

    async def test_aiogram_invalid_answers_make_journal_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = self.emulator.journal = Path(directory) / "requests.jsonl"
            article = InlineQueryResultArticle(
                id="same",
                title="Title",
                input_message_content=InputTextMessageContent(message_text="Hi"),
            )
            for results in (
                [article, article],
                [InlineQueryResultCachedAudio(id="a", audio_file_id="synthetic")],
            ):
                with self.assertRaises(TelegramBadRequest):
                    await self.bot.answer_inline_query("query", results=results)
            with self.assertRaises(TelegramBadRequest):
                await self.bot.answer_callback_query("query", text="x" * 201)
            result = verdict(journal, require_methods=["answerInlineQuery", "answerCallbackQuery"])
            self.assertFalse(result["ok"])
            self.assertEqual(len(result["refusals"]), 3)
            self.assertEqual(result["successful_methods"], {})
            self.assertEqual(self.emulator.assets, {})
            self.assertEqual(self.emulator.next_id, 1)

    async def test_inline_results_shape_ids_types_and_required_content(self):
        invalid = [
            {},
            [None],
            [1],
            ["article"],
            [{}],
            [ARTICLE, ARTICLE],
            [{**ARTICLE, "id": ""}],
            [{**ARTICLE, "id": "я" * 33}],
            [{**ARTICLE, "type": "audio"}],
            [{**ARTICLE, "type": "video"}],
            [{**ARTICLE, "title": ""}],
            [{**ARTICLE, "title": "😀" * 129}],
            [{**ARTICLE, "input_message_content": None}],
            [{**ARTICLE, "input_message_content": {}}],
            [{**ARTICLE, "input_message_content": {"message_text": ""}}],
            [{**ARTICLE, "input_message_content": {"message_text": "😀" * 2049}}],
            [{**ARTICLE, "input_message_content": {"message_text": 7}}],
            [{**ARTICLE, "input_message_content": []}],
            [{**ARTICLE, "caption": []}],
            [{**ARTICLE, "photo_file_id": 1}],
            [{**ARTICLE, "id": str(i)} for i in range(51)],
        ]
        for results in invalid:
            with self.subTest(results=results), self.assertRaises(ApiRefusal):
                self.inline(results)
        boundary = {
            **ARTICLE,
            "id": "я" * 32,
            "title": "😀" * 128,
            "input_message_content": {"message_text": "😀" * 2048},
        }
        self.assertTrue(self.inline([boundary]))
        self.assertTrue(self.inline(json.dumps([boundary])))
        self.assertTrue(self.inline([{**ARTICLE, "id": str(i)} for i in range(50)]))

    async def test_inline_empty_menu_and_server_scalar_options(self):
        for fields in ({}, {"results": None}, {"results": "null"}, {"results": []}):
            self.assertTrue(
                self.emulator.validate("answerInlineQuery", {"inline_query_id": "q", **fields}, {})
            )
        for cache in (-1, " -1 ", -1.0):
            with self.subTest(cache=cache), self.assertRaises(ApiRefusal):
                self.inline([], cache_time=cache)
        for cache in (0, 300, 301, "invalid", None, True, 2**63):
            self.assertTrue(
                self.inline([], cache_time=cache, is_personal="invalid", next_offset={})
            )
        with self.assertRaises(ApiRefusal):
            self.inline([], inline_query_id=" \t")

    async def test_inline_photo_reference_and_utf16_caption_limits(self):
        photo = await self.bot.send_photo(42, self.upload("photo.jpg"))
        result = {"type": "photo", "id": "p", "photo_file_id": photo.photo[-1].file_id}
        self.assertTrue(self.inline([{**result, "caption": "😀" * 512}]))
        self.assertTrue(
            self.inline([{**result, "input_message_content": {"message_text": "😀" * 2048}}])
        )
        for change in (
            {"photo_file_id": ""},
            {"photo_file_id": "unknown"},
            {"caption": "😀" * 513},
            {"input_message_content": {}},
            {"input_message_content": {"message_text": "😀" * 2049}},
        ):
            with self.subTest(change=change), self.assertRaises(ApiRefusal):
                self.inline([{**result, **change}])

    async def test_callback_text_url_and_cache_boundaries(self):
        self.assertTrue(self.callback(text="😀" * 200, cache_time=86400, show_alert=True))
        for fields in (
            {"text": "😀" * 201},
            {"text": {}},
            {"text": None},
            {"url": []},
            {"url": "https://example.test/" + "я" * 1024},
            {"url": "javascript:alert(1)"},
            {"url": "httpſ://example.test/"},
            {"url": "https://user:pass@example.test"},
            {"url": "https://example.test/\x85"},
            {"url": "https://example.test/%zz"},
            {"url": "https://ex%zzmple.test/"},
            {"url": "https://ex%41mple.test/"},
            {"url": "https://example.test:bad"},
            {"url": "https://[fe80::1%25en%0A]/"},
            {"url": "https://[fe80::1%25en%FF]/"},
            {"url": "https://[foo/"},
            {"url": "https://[foo]suffix/"},
            {"url": "https://example.test/#%zz"},
            {"url": "https://example.test/%A#1"},
            {"url": "https://exa|mple.test/"},
            {"url": " https://example.test"},
            {"cache_time": -1},
            {"cache_time": 86401},
            {"cache_time": True},
            {"cache_time": 1.5},
            {"cache_time": None},
            {"show_alert": "yes"},
            {"show_alert": None},
            {"show_alert": 1.0},
        ):
            with self.subTest(fields=fields), self.assertRaises(ApiRefusal):
                self.callback(**fields)
        for url in (
            "",
            "https://example.test/" + "x" * (2048 - len("https://example.test/")),
            "http://example.test",
            "tg://resolve?domain=bot",
            "https://example.test/a b",
            "https://example.test:99999",
            "https://example.test/?q=%zz",
            "https://ex%25mple.test/",
            "https://[fe80::1%25en%41]/",
            "https://[fe80::1%25en%20]/",
            "https://example.com：80/",
            "https://[foo]/",
            "https://:80/",
        ):
            self.assertTrue(self.callback(url=url))
        for text in (7, True, False):
            self.assertTrue(self.callback(text=text))
        for alert in (" true ", "FALSE", "T", "f", "1", "0", 1, -1):
            self.assertTrue(self.callback(show_alert=alert))
        for cache in (" +0001 ", 1.0):
            self.assertTrue(self.callback(cache_time=cache))

    async def test_json_and_form_refusals_remain_json_400(self):
        async with ClientSession() as client:
            for encoding in ("json", "data"):
                for method, fields in (
                    ("answerInlineQuery", {"inline_query_id": "q", "results": json.dumps([{}])}),
                    ("answerCallbackQuery", {"callback_query_id": "q", "show_alert": "bad"}),
                ):
                    async with client.post(
                        self.base + f"/bot{TOKEN}/{method}", **{encoding: fields}
                    ) as response:
                        self.assertEqual(response.status, 400)
                        self.assertFalse((await response.json())["ok"])
