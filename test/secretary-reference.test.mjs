import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSecretaryState } from "../examples/secretary/state.mjs";
import { createReferenceSecretary } from "../examples/secretary/reference.mjs";

const botId = "1000000000000042";
const a = "e8b392e9-4ddc-4992-a235-d9f36cd892fc";
const d = "e8b392e9-4ddc-4992-a235-d9f36cd892fd";
function event(connectionId = a, chatId = "42", sourceMessageId = "100") {
  return {
    id: "1",
    kind: "secretary_message",
    eventId: "stable-event",
    context: {
      conversationId: chatId === "42" ? "8" : "9",
      chatId,
      policyVersion: "3",
      sourceMessageId,
      sourceRevision: "1",
    },
    message: {
      id: sourceMessageId,
      conversationId: chatId,
      connectionId,
      senderId: chatId,
      text: "PRIVATE MESSAGE NEVER PERSISTED",
    },
  };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "lo-secretary-reference-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const store = await openSecretaryState(path, botId);
  t.after(() => store.close());
  return { path, store };
}
function client(overrides = {}) {
  const calls = [];
  return {
    calls,
    async getConnection(id) {
      return {
        id,
        ownerId: id === a ? "12" : "13",
        enabled: true,
        policyVersion: "3",
        rights: ["receive_messages", "send_messages"],
      };
    },
    async proposeDraft(input) {
      calls.push(input);
      return { id: "11111111-1111-4111-8111-111111111111", state: "draft" };
    },
    ...overrides,
  };
}
const bindings = [
  { connectionId: a, chatId: "42" },
  { connectionId: d, chatId: "43" },
];
test("unsupported media escalates to owner review without any direct send", async (t) => {
  const { store } = await fixture(t);
  const transport = client();
  const incoming = event();
  incoming.message.text = undefined;
  incoming.message.mediaStatus = "unsupported";
  await createReferenceSecretary({
    store,
    client: transport,
    bindings,
  }).process(incoming);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].reason, "cannot_answer");
  assert.equal(store.state.jobs[0].status, "drafted");
  assert.equal(store.state.jobs[0].replyId, undefined);
});

test("one bot isolates owners and chats, durably deduplicates replay and keeps incoming text private", async (t) => {
  const { path, store } = await fixture(t);
  const transport = client();
  let reference = createReferenceSecretary({
    store,
    client: transport,
    bindings,
  });
  await reference.process(event());
  await reference.process(event(d, "43"));
  await reference.process(event());
  assert.equal(transport.calls.length, 2);
  assert.notEqual(transport.calls[0].requestId, transport.calls[1].requestId);
  assert.equal(transport.calls[0].context.chatId, "42");
  assert.equal(transport.calls[1].connectionId, d);
  assert.equal(
    (await readFile(path, "utf8")).includes("PRIVATE MESSAGE"),
    false,
  );
  await store.close();
  const reopened = await openSecretaryState(path, botId);
  t.after(() => reopened.close());
  reference = createReferenceSecretary({
    store: reopened,
    client: transport,
    bindings,
  });
  await reference.process(event());
  assert.equal(transport.calls.length, 2);
});

test("an uncertain committed send survives restart and retries the exact original action", async (t) => {
  const { path, store } = await fixture(t);
  const calls = [];
  const effects = new Set();
  let first = true;
  const transport = client({
    async proposeDraft(input) {
      calls.push(input);
      effects.add(input.requestId);
      if (first) {
        first = false;
        throw Object.assign(new Error("uncertain"), { code: "timeout" });
      }
      return {
        id: "11111111-1111-4111-8111-111111111111",
        state: "sent",
        messageId: "200",
      };
    },
  });
  await assert.rejects(
    createReferenceSecretary({ store, client: transport, bindings }).process(
      event(),
    ),
  );
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).jobs[0].status,
    "pending",
  );
  await store.close();
  const reopened = await openSecretaryState(path, botId);
  t.after(() => reopened.close());
  await createReferenceSecretary({
    store: reopened,
    client: transport,
    bindings,
  }).process(event());
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(effects.size, 1);
  assert.equal(reopened.state.jobs[0].status, "sent");
});

test("revoke and source edits/deletes cancel uncertain actions; forbidden never restores them", async (t) => {
  for (const kind of ["revoke", "edit", "delete", "forbidden"])
    await t.test(kind, async (t) => {
      const { store } = await fixture(t);
      let attempts = 0;
      const transport = client({
        async proposeDraft() {
          attempts++;
          throw Object.assign(new Error("denied"), {
            code: attempts === 1 ? "timeout" : "forbidden",
          });
        },
      });
      const reference = createReferenceSecretary({
        store,
        client: transport,
        bindings,
      });
      await assert.rejects(reference.process(event()));
      if (kind === "revoke")
        await reference.process({
          id: "2",
          kind: "secretary_connection",
          connection: {
            id: a,
            ownerId: "12",
            enabled: false,
            policyVersion: "4",
          },
        });
      if (kind === "edit")
        await reference.process({
          ...event(),
          kind: "secretary_message_edited",
        });
      if (kind === "delete")
        await reference.process({
          ...event(),
          kind: "secretary_messages_deleted",
          message: undefined,
          connectionId: a,
          messageIds: ["100"],
        });
      await reference.process(event());
      await reference.process(event());
      assert.equal(store.state.jobs[0].status, "cancelled");
      assert.equal(attempts, kind === "forbidden" ? 2 : 1);
    });
});

test("review is the default; owner/delegated echoes and foreign chats never propose", async (t) => {
  const { store } = await fixture(t);
  const transport = client();
  await createReferenceSecretary({ store, client: transport }).process(event());
  const reference = createReferenceSecretary({
    store,
    client: transport,
    bindings,
  });
  const incoming = event();
  for (const update of [
    event(a, "99"),
    { ...incoming, message: { ...incoming.message, senderId: "12" } },
    { ...incoming, message: { ...incoming.message, secretaryBotId: botId } },
    { ...incoming, message: { ...incoming.message, text: undefined } },
  ])
    await reference.process(update);
  assert.equal(transport.calls.length, 1);
  assert.equal(store.state.jobs.length, 1);
  assert.equal(store.state.jobs[0].status, "drafted");
});

test("a private state cannot be opened by two processes or reused for another bot", async (t) => {
  const { path, store } = await fixture(t);
  await store.save();
  await assert.rejects(
    openSecretaryState(path, botId),
    (error) => error.code === "EEXIST",
  );
  await store.close();
  await assert.rejects(
    openSecretaryState(path, "1000000000000043"),
    /Incompatible/,
  );
});

test("retention expires pending jobs and removes old receipts without any new event", async (t) => {
  const { store } = await fixture(t);
  let timestamp = 1700000000000;
  const transport = client({
    async proposeDraft() {
      throw Object.assign(new Error("uncertain"), { code: "timeout" });
    },
  });
  const reference = createReferenceSecretary({
    store,
    client: transport,
    bindings,
    now: () => timestamp,
  });
  await assert.rejects(reference.process(event()));
  timestamp += 24 * 3600000;
  await reference.sweep();
  assert.equal(store.state.jobs[0].status, "cancelled");
  timestamp += 6 * 24 * 3600000;
  await reference.sweep();
  assert.equal(store.state.jobs.length, 0);
});

test("shutdown during authorization preserves pending identity and starts no send", async (t) => {
  const { store } = await fixture(t);
  const shutdown = new AbortController();
  const transport = client();
  const original = transport.getConnection;
  transport.getConnection = async (id) => {
    const connection = await original(id);
    shutdown.abort();
    return connection;
  };
  const reference = createReferenceSecretary({
    store,
    client: transport,
    bindings,
    signal: shutdown.signal,
  });
  await assert.rejects(
    reference.process(event()),
    (error) => error.code === "aborted",
  );
  await reference.flush();
  assert.equal(transport.calls.length, 0);
  assert.equal(store.state.jobs[0].status, "pending");
});
