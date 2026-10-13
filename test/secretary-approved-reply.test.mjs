import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";
import { BotError } from "@lo-ink/bot-sdk";

async function helper(t) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "lo-approved-reply-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  symlinkSync(
    join(root, "node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  const source = readFileSync(
    join(root, "examples/secretary-approved-reply.ts"),
    "utf8",
  );
  writeFileSync(
    join(directory, "helper.js"),
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText,
  );
  return (await import(pathToFileURL(join(directory, "helper.js")).href))
    .sendApprovedReply;
}
const input = () => ({
  connectionId: "e8b392e9-4ddc-4992-a235-d9f36cd892fc",
  context: {
    conversationId: "71",
    chatId: "42",
    policyVersion: "3",
    sourceMessageId: "91",
    sourceRevision: "1",
  },
  requestId: "original-approved-request",
  text: "Approved exact reply",
  quote: { text: "Exact source", offsetUtf16: 0 },
});
const connection = () => ({
  id: input().connectionId,
  ownerId: "8",
  schemaVersion: 1,
  policyVersion: "3",
  createdAt: 1,
  enabled: true,
  rights: ["receive_messages", "send_messages"],
});
function transport(
  grant,
  send = async () => ({ id: "92", conversationId: "42" }),
) {
  const calls = [];
  return {
    calls,
    async executeSecretary(operation, body) {
      calls.push({ operation, body: structuredClone(body) });
      if (operation === "getConnection")
        return typeof grant === "function" ? grant() : grant;
      if (operation === "sendText") return send(body);
      assert.fail(`Unexpected operation ${operation}`);
    },
  };
}

test("approved reply checks each delegated consent condition before any send", async (t) => {
  const sendApproved = await helper(t);
  const cases = [
    { enabled: false },
    { ownerId: "9" },
    { policyVersion: "4" },
    { rights: ["send_messages"] },
    { rights: ["receive_messages"] },
  ];
  for (const patch of cases) {
    const client = transport({ ...connection(), ...patch });
    assert.equal(await sendApproved(client, input(), "8"), undefined);
    assert.deepEqual(
      client.calls.map((x) => x.operation),
      ["getConnection"],
    );
  }
  const client = transport(connection());
  const self = input();
  self.context.chatId = "8";
  assert.equal(await sendApproved(client, self, "8"), undefined);
  assert.deepEqual(
    client.calls.map((x) => x.operation),
    ["getConnection"],
  );
});

test("approval input including context and quote is snapshotted before awaiting consent", async (t) => {
  const sendApproved = await helper(t);
  let resolveGrant;
  const waiting = new Promise((resolve) => {
    resolveGrant = resolve;
  });
  const client = transport(() => waiting);
  const approved = input(),
    original = structuredClone(approved);
  const sending = sendApproved(client, approved, "8");
  approved.connectionId = "e8b392e9-4ddc-4992-a235-d9f36cd892fd";
  approved.text = "Unapproved replacement";
  approved.requestId = "replacement-key";
  approved.context.sourceMessageId = "999";
  approved.context.policyVersion = "99";
  approved.quote.text = "Unapproved quote";
  approved.quote.offsetUtf16 = 20;
  resolveGrant(connection());
  assert.deepEqual(await sending, { id: "92", conversationId: "42" });
  assert.deepEqual(client.calls, [
    {
      operation: "getConnection",
      body: { connectionId: original.connectionId },
    },
    { operation: "sendText", body: original },
  ]);
});

test("send failure has one attempt and no implicit proposal or replacement key", async (t) => {
  const sendApproved = await helper(t);
  for (const code of ["forbidden", "transport"]) {
    const failure = new BotError(code, "Synthetic failure");
    const client = transport(connection(), async () => {
      throw failure;
    });
    const approved = input();
    await assert.rejects(
      sendApproved(client, approved, "8"),
      (error) => error === failure,
    );
    assert.deepEqual(
      client.calls.map((x) => x.operation),
      ["getConnection", "sendText"],
    );
    assert.deepEqual(client.calls[1].body, approved);
  }
});
