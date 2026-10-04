import test from "node:test";
import assert from "node:assert/strict";
import { createBotClient } from "@lo-ink/bot-sdk";
import {
  decodeLoBotUpdate,
  parseLoBotWebhookUpdate,
  createLoHttpBotTransport,
} from "../dist/index.js";

test("app data normalizes without a stored message ID; user and cursor IDs retain precision", () => {
  const update = parseLoBotWebhookUpdate(
    '{"update_id":9007199254740993,"message":{"chat":{"id":9007199254740995},"from":{"id":9007199254740995},"web_app_data":{"data":"fixture","button_text":"SDK"}}}',
  );
  assert.deepEqual(update, {
    id: "9007199254740993",
    kind: "appData",
    appData: {
      conversationId: "9007199254740995",
      userId: "9007199254740995",
      data: "fixture",
      buttonText: "SDK",
    },
  });
  assert.equal(Object.hasOwn(update.appData, "messageId"), false);
  assert.deepEqual(
    decodeLoBotUpdate({
      update_id: 1,
      message: { chat: { id: 42 }, message_id: 17, web_app_data: { data: "" } },
    }),
    {
      id: "1",
      kind: "appData",
      appData: { conversationId: "42", messageId: "17", data: "" },
    },
  );
});
test("callback updates and answers use native LO values with exact HTTP serialization", async () => {
  const update = decodeLoBotUpdate({
    update_id: 1,
    callback_query: {
      id: "fixture-query",
      from: { id: 42 },
      data: "confirm",
      message: {
        message_id: 7,
        date: 1,
        chat: { id: 42, type: "private" },
        text: "Action",
      },
    },
  });
  assert.equal(update.kind, "callback");
  assert.equal(update.callback.userId, "42");
  assert.equal(update.callback.message.id, "7");
  const client = createBotClient(
    createLoHttpBotTransport({
      token: "7:synthetic",
      fetch: async (url, options) => {
        assert.ok(url.endsWith("/answerCallbackQuery"));
        assert.deepEqual(JSON.parse(options.body), {
          callback_query_id: "fixture-query",
          text: "Done",
          show_alert: false,
        });
        return Response.json({ ok: true, result: true });
      },
    }),
  );
  assert.equal(
    await client.answerCallback({
      callbackId: update.callback.id,
      text: "Done",
      showAlert: false,
    }),
    true,
  );
});
test("malformed interactions fail instead of falling through to a successful unhandled update", () => {
  for (const update of [
    { update_id: 1, message: { chat: { id: 42 }, web_app_data: { data: 42 } } },
    {
      update_id: 1,
      message: { chat: { id: 42 }, message_id: 0, web_app_data: { data: "x" } },
    },
    {
      update_id: 1,
      message: {
        chat: { id: 42 },
        from: { id: 0 },
        web_app_data: { data: "x" },
      },
    },
    { update_id: 1, callback_query: { id: "x", from: { id: 0 } } },
    { update_id: 1, callback_query: { id: "x", from: { id: 42 }, data: 42 } },
    {
      update_id: 1,
      callback_query: { id: "x", from: { id: 42 } },
      message: { message_id: 7, chat: { id: 42 } },
    },
  ])
    assert.throws(() => decodeLoBotUpdate(update), {
      code: "invalid-response",
    });
});
test("reply keyboard removal serializes without other keyboard shapes", async () => {
  const client = createBotClient(
    createLoHttpBotTransport({
      token: "7:synthetic",
      fetch: async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body).reply_markup, {
          remove_keyboard: true,
        });
        return Response.json({
          ok: true,
          result: {
            message_id: 7,
            date: 1,
            chat: { id: 42, type: "private" },
            text: "Removed",
          },
        });
      },
    }),
  );
  await client.sendMessage({
    conversationId: "42",
    text: "Removed",
    replyMarkup: { removeKeyboard: true },
  });
});

test("incoming audio and photos expose reusable file IDs through native getUpdates", () => {
  for (const [kind, payload, expected] of [
    ["audio", { file_id: "audio-fixture" }, "audio-fixture"],
    ["photo", [{ file_id: "small" }, { file_id: "large" }], "large"],
  ]) {
    const update = decodeLoBotUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        date: 1,
        chat: { id: 42, type: "private" },
        caption: "Fixture",
        [kind]: payload,
      },
    });
    assert.deepEqual(update.message, {
      id: "7",
      conversationId: "42",
      caption: "Fixture",
      fileId: expected,
      mediaType: kind,
    });
  }
});
