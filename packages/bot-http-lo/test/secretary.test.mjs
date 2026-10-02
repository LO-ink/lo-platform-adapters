import assert from "node:assert/strict";
import { test } from "node:test";
import { createBotClient, createSecretaryClient } from "@lo-ink/bot-sdk";
import {
  createLoHttpBotTransport,
  decodeLoBotUpdate,
  parseLoBotWebhookUpdate,
} from "../dist/index.js";

const connectionId = "e8b392e9-4ddc-4992-a235-d9f36cd892fc";
const context = {
  conversationId: "8",
  chatId: "42",
  policyVersion: "9007199254740993",
  sourceMessageId: "9007199254740995",
  sourceRevision: "4",
};
const wireContext = {
  conversation_id: "8",
  chat_id: "42",
  policy_version: context.policyVersion,
  source_message_id: context.sourceMessageId,
  source_revision: "4",
};
const scope = { connectionId, context, requestId: "stable-action-id" };
test("draft proposals use the review endpoint and decode exact scoped receipts", async () => {
  const receipt = {
    lo_draft_id: "11111111-1111-4111-8111-111111111111",
    business_connection_id: connectionId,
    lo_conversation_id: context.conversationId,
    chat_id: context.chatId,
    lo_source_message_id: context.sourceMessageId,
    lo_revision: "1",
    state: "draft",
    mode: "review",
    text: "proposed",
    reason: "manual_review",
    date: 1700000000,
    expires_at: 1700086400,
    lo_secretary_bot_id: "1000000000000042",
  };
  const client = createSecretaryClient(
    transport((method, body) => {
      assert.equal(method, "proposeBusinessDraft");
      assert.equal(body.lo_request_id, scope.requestId);
      assert.equal(body.lo_draft_reason, "manual_review");
      assert.equal(body.lo_context.policy_version, context.policyVersion);
      return receipt;
    }),
  );
  const result = await client.proposeDraft({
    ...scope,
    text: "proposed",
    reason: "manual_review",
  });
  assert.equal(result.state, "draft");
  assert.equal(result.sourceMessageId, context.sourceMessageId);
  assert.equal(result.messageId, undefined);
});
test("draft receipts cannot substitute another chat, owner scope, text or auto outcome", async () => {
  const receipt = {
    lo_draft_id: "11111111-1111-4111-8111-111111111111",
    business_connection_id: connectionId,
    lo_conversation_id: context.conversationId,
    chat_id: context.chatId,
    lo_source_message_id: context.sourceMessageId,
    lo_revision: "1",
    state: "draft",
    mode: "review",
    text: "proposed",
    reason: "template",
    date: 1700000000,
    expires_at: 1700086400,
    lo_secretary_bot_id: "1000000000000042",
  };
  for (const change of [
    { business_connection_id: "11111111-1111-4111-8111-111111111111" },
    { chat_id: "99" },
    { text: "other" },
    { mode: "auto" },
    { state: "sent" },
    { lo_revision: 0 },
    { lo_secretary_bot_id: "12" },
  ]) {
    const client = createSecretaryClient(
      transport(() => ({ ...receipt, ...change })),
    );
    await assert.rejects(
      client.proposeDraft({ ...scope, text: "proposed", reason: "template" }),
      (error) => error.code === "invalid-response",
    );
  }
});
const connection = {
  id: connectionId,
  user: { id: 12, is_bot: false },
  date: 1700000000,
  is_enabled: true,
  lo_schema_version: 1,
  lo_policy_version: context.policyVersion,
  lo_rights: ["receive_messages", "send_messages", "mark_read"],
};
const incoming = {
  message_id: context.sourceMessageId,
  date: 1700000001,
  from: { id: 42, is_bot: false },
  chat: { id: 42, type: "private" },
  text: "Incoming",
  business_connection_id: connectionId,
  lo_context: wireContext,
  lo_event_id: "stable-event-id",
};

function transport(handler) {
  return createLoHttpBotTransport({
    token: "1000000000000042:test-token",
    fetch: async (url, options) => {
      const method = new URL(url).pathname.split("/").at(-1);
      return new Response(
        JSON.stringify({
          ok: true,
          result: await handler(method, JSON.parse(options.body)),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
}

test("secretary methods preserve exact scoped context and independent read/delete operations", async () => {
  const calls = [];
  const client = createSecretaryClient(
    transport((method, body) => {
      calls.push({ method, body });
      if (method === "getBusinessConnection") return connection;
      if (method === "sendMessage" || method === "editMessageText")
        return {
          ...incoming,
          message_id: "9007199254740997",
          from: { id: 12, is_bot: false },
          text: body.text,
          lo_secretary_bot_id: "1000000000000042",
        };
      return true;
    }),
  );
  assert.equal(
    (await client.getConnection(connectionId)).policyVersion,
    context.policyVersion,
  );
  assert.equal(
    (await client.sendText({ ...scope, text: "Answer" })).senderId,
    "12",
  );
  await client.editText({
    ...scope,
    messageId: "9007199254740997",
    text: "Edited",
  });
  await client.markRead(scope);
  await client.deleteMessages({ ...scope, messageIds: ["9007199254740997"] });
  await client.deleteMessages({
    ...scope,
    messageIds: ["9007199254740997"],
    deleteAll: true,
  });
  assert.deepEqual(
    calls.map((call) => call.method),
    [
      "getBusinessConnection",
      "sendMessage",
      "editMessageText",
      "readBusinessMessage",
      "deleteBusinessMessages",
      "deleteBusinessMessages",
    ],
  );
  for (const { body } of calls.slice(1)) {
    assert.deepEqual(body.lo_context, wireContext);
    assert.equal(body.lo_request_id, scope.requestId);
    assert.equal(body.business_connection_id, connectionId);
    assert.equal(Object.hasOwn(body.lo_context, "credential_version"), false);
    assert.equal(Object.hasOwn(body, "owner_id"), false);
  }
  assert.equal(calls[3].body.message_id, context.sourceMessageId);
  assert.equal(Object.hasOwn(calls[4].body, "lo_delete_all"), false);
  assert.equal(calls[5].body.lo_delete_all, true);
  assert.deepEqual(calls[4].body.message_ids, ["9007199254740997"]);
});

test("polling and authenticated webhook bodies use identical business event normalization", async () => {
  const raw = [
    { update_id: 1, business_connection: connection },
    { update_id: 2, business_message: incoming },
    { update_id: 3, edited_business_message: { ...incoming, text: "Changed" } },
    {
      update_id: 4,
      deleted_business_messages: {
        business_connection_id: connectionId,
        chat: incoming.chat,
        message_ids: [context.sourceMessageId],
        lo_context: wireContext,
        lo_event_id: "deleted-event-id",
      },
    },
  ];
  const client = createBotClient(transport(() => raw));
  const updates = await client.getUpdates();
  assert.deepEqual(updates, raw.map(decodeLoBotUpdate));
  assert.deepEqual(
    updates,
    raw.map((value) => parseLoBotWebhookUpdate(JSON.stringify(value))),
  );
  assert.deepEqual(
    updates.map((value) => value.kind),
    [
      "secretary_connection",
      "secretary_message",
      "secretary_message_edited",
      "secretary_messages_deleted",
    ],
  );
  assert.equal(updates[1].context.conversationId, "8");
  assert.equal(updates[1].message.conversationId, "42");
  assert.equal(updates[1].eventId, "stable-event-id");
  const numericWire = JSON.stringify(raw[1])
    .replaceAll('"9007199254740995"', "9007199254740995")
    .replaceAll('"9007199254740993"', "9007199254740993");
  assert.equal(
    parseLoBotWebhookUpdate(numericWire).context.policyVersion,
    context.policyVersion,
  );
  assert.equal(
    parseLoBotWebhookUpdate(numericWire).message.id,
    context.sourceMessageId,
  );
});

test("malformed, cross-chat and mixed updates fail before reaching a handler", () => {
  const invalid = [
    { ...incoming, lo_event_id: "" },
    { ...incoming, lo_context: { ...wireContext, chat_id: "43" } },
    { ...incoming, message_id: "9007199254740997" },
    { ...incoming, from: { id: 1000000000000042, is_bot: true } },
  ];
  for (const business_message of invalid)
    assert.throws(
      () => decodeLoBotUpdate({ update_id: 2, business_message }),
      (error) => error.code === "invalid-response",
    );
  assert.throws(() =>
    decodeLoBotUpdate({
      update_id: 2,
      business_message: incoming,
      message: incoming,
    }),
  );
  assert.throws(() => parseLoBotWebhookUpdate("x".repeat((2 << 20) + 1)));
});

test("a foreign connection response and an unattributed write result fail closed", async () => {
  await assert.rejects(
    createSecretaryClient(
      transport(() => ({
        ...connection,
        id: "e8b392e9-4ddc-4992-a235-d9f36cd892fd",
      })),
    ).getConnection(connectionId),
    (error) => error.code === "invalid-response",
  );
  await assert.rejects(
    createSecretaryClient(
      transport(() => ({ ...incoming, text: "Answer" })),
    ).sendText({ ...scope, text: "Answer" }),
    (error) => error.code === "invalid-response",
  );
});

function scopedFile(sourceContext = wireContext, expiry, mediaId = 77) {
  const descriptor = {
    scope: {
      botId: "1000000000000042",
      connectionId,
      conversationId: sourceContext.conversation_id,
      peerId: sourceContext.chat_id,
      policyVersion: sourceContext.policy_version,
      sourceMessageId: sourceContext.source_message_id,
      sourceRevision: sourceContext.source_revision,
      credentialVersion: 2,
      action: "receive_messages",
      eventAt: 1700000000,
      eventKind: "created",
    },
    kind: "photo",
    mediaId,
    size: "lg",
    ...(expiry ? { expiresAt: expiry } : {}),
  };
  return `secretary-v1:${Buffer.from(JSON.stringify(descriptor)).toString("base64url")}:${"x".repeat(22)}`;
}

test("secretary albums preserve every scoped attachment and caption; foreign source files fail closed", () => {
  const photo = {
    file_id: scopedFile(),
    file_unique_id: `secretary:${"a".repeat(64)}`,
    width: 100,
    height: 200,
  };
  const value = {
    ...incoming,
    text: undefined,
    caption: "Album caption",
    lo_media_status: "available",
    lo_album_id: `${connectionId}:${context.sourceMessageId}:${context.sourceRevision}`,
    lo_attachments: [
      { kind: "photo", photo: [photo] },
      {
        kind: "photo",
        photo: [{ ...photo, file_unique_id: `secretary:${"b".repeat(64)}` }],
      },
    ],
  };
  const update = decodeLoBotUpdate({ update_id: 5, business_message: value });
  assert.equal(update.message.caption, "Album caption");
  assert.equal(update.message.text, undefined);
  assert.equal(update.message.attachments.length, 2);
  assert.equal(update.message.attachments[0].sizes[0].fileId, photo.file_id);
  for (const file_id of [
    "photo:77:lg:ordinary-grant",
    scopedFile({ ...wireContext, chat_id: "43" }),
    scopedFile({ ...wireContext, source_revision: "5" }),
  ]) {
    assert.throws(
      () =>
        decodeLoBotUpdate({
          update_id: 5,
          business_message: {
            ...value,
            lo_attachments: [{ kind: "photo", photo: [{ ...photo, file_id }] }],
            lo_album_id: undefined,
          },
        }),
      (error) => error.code === "invalid-response",
    );
  }
  assert.throws(() =>
    decodeLoBotUpdate({
      update_id: 5,
      business_message: {
        ...value,
        lo_album_id: `${connectionId}:${context.sourceMessageId}:5`,
      },
    }),
  );
  const unsupported = decodeLoBotUpdate({
    update_id: 6,
    business_message: { ...incoming, lo_media_status: "unsupported" },
  });
  assert.equal(unsupported.message.mediaStatus, "unsupported");
  assert.equal(unsupported.message.attachments, undefined);
});

test("getFile returns only an expiring path for the exact requested source descriptor", async () => {
  const fileId = scopedFile();
  let requested;
  const client = createSecretaryClient(
    transport((method, body) => {
      requested = { method, body };
      return {
        file_id: fileId,
        file_unique_id: `secretary:${"a".repeat(64)}`,
        file_path: scopedFile(wireContext, 1700000310),
        lo_expires_at: 1700000310,
      };
    }),
  );
  const file = await client.getFile(fileId);
  assert.equal(file.expiresAt, 1700000310);
  assert.deepEqual(requested, { method: "getFile", body: { file_id: fileId } });
  const foreign = createSecretaryClient(
    transport(() => ({
      file_id: fileId,
      file_unique_id: `secretary:${"a".repeat(64)}`,
      file_path: scopedFile({ ...wireContext, chat_id: "43" }, 1700000310),
      lo_expires_at: 1700000310,
    })),
  );
  await assert.rejects(
    foreign.getFile(fileId),
    (error) => error.code === "invalid-response",
  );
  await assert.rejects(
    client.getFile("photo:77:lg:ordinary"),
    (error) => error.code === "invalid-input",
  );
});

test("selected quote roundtrips against the exact source; substituted source or fragment fails closed", async () => {
  const quote = { text: "question", offsetUtf16: 3 };
  let wire;
  let tamper = false;
  const client = createSecretaryClient(
    transport((method, body) => {
      assert.equal(method, "sendMessage");
      wire = body;
      return {
        ...incoming,
        message_id: "901",
        from: { id: 12, is_bot: false },
        text: body.text,
        lo_secretary_bot_id: "1000000000000042",
        lo_reply_to_message_id: tamper ? "99" : context.sourceMessageId,
        lo_quote: body.lo_quote,
      };
    }),
  );
  const result = await client.sendText({ ...scope, text: "Answer", quote });
  assert.deepEqual(wire.lo_quote, quote);
  assert.deepEqual(result.quote, quote);
  assert.equal(result.replyToMessageId, context.sourceMessageId);
  tamper = true;
  await assert.rejects(
    client.sendText({ ...scope, text: "Answer", quote }),
    (error) => error.code === "invalid-response",
  );
});

test("delegated media keeps owner attribution and scoped references; foreign source is rejected before fetch", async () => {
  const first = scopedFile();
  const second = scopedFile(wireContext, undefined, 78);
  let calls = 0;
  const client = createSecretaryClient(
    transport((method, body) => {
      calls++;
      assert.equal(method, "sendBusinessMedia");
      assert.deepEqual(body.lo_media, [first, second]);
      return {
        ...incoming,
        message_id: "901",
        from: { id: 12, is_bot: false },
        text: undefined,
        caption: body.caption,
        lo_secretary_bot_id: "1000000000000042",
        lo_media_references: body.lo_media,
        lo_album_id: connectionId + ":901:1",
      };
    }),
  );
  const result = await client.sendMedia({
    ...scope,
    fileIds: [first, second],
    caption: "caption",
  });
  assert.equal(result.senderId, "12");
  assert.equal(result.secretaryBotId, "1000000000000042");
  assert.equal(result.albumId, connectionId + ":901:1");
  assert.deepEqual(result.mediaFileIds, [first, second]);
  await assert.rejects(
    client.sendMedia({
      ...scope,
      fileIds: [scopedFile({ ...wireContext, source_message_id: "99" })],
    }),
    (error) => error.code === "invalid-response",
  );
  assert.equal(calls, 1);
});
