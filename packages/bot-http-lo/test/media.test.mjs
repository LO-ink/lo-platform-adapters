import test from "node:test";
import assert from "node:assert/strict";
import {
  createBotClient,
  RateLimited,
  NotAllowed,
  BadRequest,
  Unavailable,
  BOT_MEDIA_LIMITS,
} from "@lo-ink/bot-sdk";
import { createLoHttpBotTransport, HttpBotError } from "../dist/index.js";
const wireMarkup = {
  inline_keyboard: [
    [{ text: "Открыть", web_app: { url: "https://app.example.test/" } }],
  ],
};
const markup = {
  inlineKeyboard: [
    [{ text: "Открыть", miniApp: { url: "https://app.example.test/" } }],
  ],
};
const envelope = (result) => Response.json({ ok: true, result });
const wireMessage = (media) => ({
  message_id: 42,
  date: 1800000000,
  chat: { id: 9007199254740993n.toString(), type: "private" },
  ...media,
});
function setup(handler) {
  let calls = 0;
  const client = createBotClient(
    createLoHttpBotTransport({
      token: "42:fake-token",
      fetch: async (url, request) => {
        calls++;
        return handler(url, request);
      },
    }),
  );
  return { client, calls: () => calls };
}
test("keyboard requests match the real Bot API JSON byte for byte", async () => {
  const { client } = setup((url, request) => {
    const operation = url.split("/").at(-1);
    assert.equal(request.headers["content-type"], "application/json");
    if (operation === "setChatMenuButton") {
      assert.equal(
        request.body,
        JSON.stringify({
          chat_id: "9007199254740993",
          menu_button: {
            type: "web_app",
            text: "Открыть",
            web_app: { url: "https://app.example.test/" },
          },
        }),
      );
      return envelope(true);
    }
    assert.equal(
      request.body,
      JSON.stringify({
        chat_id: "9007199254740993",
        ...(operation === "editMessageText" ? { message_id: "42" } : {}),
        text: "Тест",
        reply_markup: wireMarkup,
      }),
    );
    return envelope(wireMessage({ text: "Тест" }));
  });
  await client.sendMessage({
    conversationId: "9007199254740993",
    text: "Тест",
    replyMarkup: markup,
  });
  await client.editMessage({
    conversationId: "9007199254740993",
    messageId: "42",
    text: "Тест",
    replyMarkup: markup,
  });
  await client.setChatMenuButton({
    conversationId: "9007199254740993",
    menuButton: {
      type: "miniApp",
      text: "Открыть",
      miniApp: { url: "https://app.example.test/" },
    },
  });
});
for (const [method, kind, name, mime] of [
  ["sendPhoto", "photo", "test.png", "image/png"],
  ["sendDocument", "document", "test.pdf", "application/pdf"],
  ["sendVoice", "voice", "test.m4a", "audio/mp4"],
]) {
  test(`${method}: upload and cached fileId use real multipart/JSON contracts`, async () => {
    const data = new Uint8Array([1, 2, 3]);
    const { client, calls } = setup(async (_url, request) => {
      if (request.body instanceof FormData) {
        const form = request.body;
        assert.equal(
          request.headers,
          undefined,
          "fetch owns the multipart boundary",
        );
        assert.equal(form.get("chat_id"), "9007199254740993");
        assert.equal(form.get("caption"), kind === "voice" ? null : "Подпись");
        assert.equal(form.get("reply_markup"), JSON.stringify(wireMarkup));
        const file = form.get(kind);
        assert.equal(file.name, name);
        assert.equal(file.type, mime);
        assert.deepEqual(new Uint8Array(await file.arrayBuffer()), data);
        // Serialize and parse with the native multipart parser to verify actual bytes.
        const actual = new Request("https://example.test/", {
          method: "POST",
          body: form,
        });
        const parsed = await actual.formData();
        assert.equal(parsed.get("reply_markup"), JSON.stringify(wireMarkup));
        assert.equal(parsed.get(kind).name, name);
      } else {
        assert.deepEqual(JSON.parse(request.body), {
          chat_id: "9007199254740993",
          [kind]: "lo-large-file",
        });
      }
      return envelope(
        wireMessage(
          kind === "photo"
            ? {
                photo: [
                  { file_id: "lo-small-file", width: 20, height: 20 },
                  { file_id: "lo-large-file", width: 100, height: 100 },
                ],
              }
            : {
                [kind]: {
                  file_id: "lo-large-file",
                  file_unique_id: "unique",
                  duration: 1,
                },
              },
        ),
      );
    });
    const result = await client[method]({
      conversationId: "9007199254740993",
      [kind]: { data, name, mime },
      ...(kind === "voice" ? {} : { caption: "Подпись" }),
      replyMarkup: markup,
    });
    assert.equal(result.fileId, "lo-large-file");
    await client[method]({
      conversationId: "9007199254740993",
      [kind]: { fileId: result.fileId },
    });
    assert.equal(calls(), 2);
  });
}
test("bad inputs fail before fetch, including UTF-16 captions and UTF-8 callbacks", async () => {
  const { client, calls } = setup(() => assert.fail("fetch must not run"));
  const bad = [
    () =>
      client.sendPhoto({
        conversationId: "42",
        photo: "https://example.test/a.png",
      }),
    () =>
      client.sendPhoto({
        conversationId: "42",
        photo: { fileId: "https://example.test/a.png" },
      }),
    () =>
      client.sendPhoto({
        conversationId: "42",
        photo: { fileId: "lo-id" },
        caption: "😀".repeat(513),
      }),
    () =>
      client.sendPhoto({
        conversationId: "42",
        photo: {
          data: new Blob([new Uint8Array(BOT_MEDIA_LIMITS.photoBytes + 1)]),
          name: "big.png",
        },
      }),
    () =>
      client.sendDocument({
        conversationId: "42",
        document: {
          data: new Blob([new Uint8Array(BOT_MEDIA_LIMITS.documentBytes + 1)]),
          name: "big.pdf",
        },
      }),
    () =>
      client.sendVoice({
        conversationId: "42",
        voice: { data: new Uint8Array([1]), name: "v.ogg", mime: "audio/ogg" },
      }),
    () =>
      client.sendVoice({
        conversationId: "42",
        voice: { fileId: "lo-id" },
        caption: "ignored?",
      }),
    () =>
      client.sendMessage({
        conversationId: "42",
        text: "x",
        replyMarkup: {
          inlineKeyboard: [
            [{ text: "x", miniApp: { url: "http://example.test/" } }],
          ],
        },
      }),
    () =>
      client.sendMessage({
        conversationId: "-42",
        text: "x",
        replyMarkup: markup,
      }),
    () =>
      client.sendMessage({
        conversationId: "42",
        text: "x",
        replyMarkup: {
          inlineKeyboard: [[{ text: "x", callbackData: "я".repeat(33) }]],
        },
      }),
    () =>
      client.sendMessage({
        conversationId: "42",
        text: "x",
        replyMarkup: {
          keyboard: [
            [
              {
                text: "x",
                miniApp: { url: "https://example.test/" + "я".repeat(256) },
              },
            ],
          ],
        },
      }),
  ];
  for (const operation of bad)
    await assert.rejects(operation(), (e) => e.code === "invalid-input");
  assert.equal(calls(), 0);
});
test("stream upload is bounded before network and preserves cancellation", async () => {
  const ok = setup(async (_url, request) => {
    assert.deepEqual(
      new Uint8Array(await request.body.get("document").arrayBuffer()),
      new Uint8Array([1, 2]),
    );
    return envelope(wireMessage({ document: { file_id: "doc" } }));
  });
  await ok.client.sendDocument({
    conversationId: "9007199254740993",
    document: {
      data: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
          c.enqueue(new Uint8Array([2]));
          c.close();
        },
      }),
      name: "a.txt",
    },
  });
  const noNetwork = setup(() => assert.fail("fetch must not run"));
  let cancelled = false;
  const stream = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(1 << 20));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    noNetwork.client.sendPhoto({
      conversationId: "42",
      photo: { data: stream, name: "big.png" },
    }),
    (e) => e.code === "invalid-input",
  );
  assert.equal(cancelled, true);
  assert.equal(noNetwork.calls(), 0);
  const controller = new AbortController();
  const pending = noNetwork.client.sendDocument(
    {
      conversationId: "42",
      document: { data: new ReadableStream(), name: "waiting.txt" },
    },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(pending, (e) => e.code === "aborted");
  assert.equal(noNetwork.calls(), 0);
});
test("real API error envelopes map to SDK classes without retries", async () => {
  for (const [status, description, Constructor] of [
    [429, "Too Many Requests: retry after 7", RateLimited],
    [403, "Forbidden: bot can't initiate conversation with a user", NotAllowed],
    [403, "Forbidden: bot was blocked by the user", NotAllowed],
    [400, "Bad Request: wrong file identifier/HTTP URL specified", BadRequest],
    [500, "Internal Server Error", Unavailable],
  ]) {
    const { client, calls } = setup(() =>
      Response.json(
        {
          ok: false,
          error_code: status,
          description,
          parameters: { retry_after: 7 },
        },
        { status },
      ),
    );
    await assert.rejects(
      client.sendMessage({ conversationId: "42", text: "test" }),
      (e) => {
        assert.ok(e instanceof Constructor);
        assert.ok(e instanceof HttpBotError);
        if (status === 429) assert.equal(e.retryAfterSec, 7);
        if (status === 400) assert.equal(e.description, description);
        return true;
      },
    );
    assert.equal(calls(), 1);
  }
  const offline = setup(() => {
    throw new Error("private URL with token");
  });
  await assert.rejects(
    offline.client.sendMessage({ conversationId: "42", text: "x" }),
    (e) => e instanceof Unavailable && !e.message.includes("token"),
  );
  assert.equal(offline.calls(), 1);
});

test("malformed upload chunks cancel the source without fetching or leaking its lock", async () => {
  const { client, calls } = setup(() => assert.fail("fetch must not run"));
  let cancelled = 0;
  const stream = new ReadableStream({
    start(c) {
      c.enqueue("not bytes");
    },
    cancel() {
      cancelled++;
      throw new Error("source cancel failure");
    },
  });
  await assert.rejects(
    client.sendDocument({
      conversationId: "42",
      document: { data: stream, name: "fixture.txt" },
    }),
    (e) => e.code === "invalid-input",
  );
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
  assert.equal(calls(), 0);
});

test("voice Blob MIME validation agrees with the serialized multipart type", async () => {
  const { client, calls } = setup((_url, request) => {
    assert.equal(request.body.get("voice").type, "audio/aac");
    return envelope(wireMessage({ voice: { file_id: "voice" } }));
  });
  await assert.rejects(
    client.sendVoice({
      conversationId: "9007199254740993",
      voice: {
        data: new Blob(["fixture"], { type: "audio/ogg" }),
        name: "voice.m4a",
      },
    }),
    (e) => e.code === "invalid-input",
  );
  assert.equal(calls(), 0);
  await client.sendVoice({
    conversationId: "9007199254740993",
    voice: {
      data: new Blob(["fixture"], { type: "application/octet-stream" }),
      name: "voice.aac",
      mime: "audio/aac",
    },
  });
  assert.equal(calls(), 1);
});
