import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSecretaryClient } from "@lo-ink/bot-sdk";
import {
  createLoHttpBotTransport,
  decodeLoBotUpdate,
  parseLoBotWebhookUpdate,
} from "../packages/bot-http-lo/dist/index.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("./fixtures/secretary/updates.json", import.meta.url),
    "utf8",
  ),
);
for (const fixture of fixtures) {
  test(`synthetic secretary contract: ${fixture.name}`, () => {
    const decode = () => decodeLoBotUpdate(fixture.wire);
    const webhook = () => parseLoBotWebhookUpdate(JSON.stringify(fixture.wire));
    if (fixture.invalid) {
      assert.throws(decode, (error) => error.code === "invalid-response");
      assert.throws(webhook, (error) => error.code === "invalid-response");
      return;
    }
    const event = decode();
    assert.deepEqual(webhook(), event);
    assert.equal(event.kind, fixture.kind);
    assert.equal(event.id, fixture.wire.update_id);
    if (fixture.enabled !== undefined)
      assert.equal(event.connection.enabled, fixture.enabled);
    if (event.context)
      assert.equal(event.context.policyVersion, "9007199254740993");
  });
}

test("an uncertain committed proposal repeats exactly one request identity", async () => {
  const event = decodeLoBotUpdate(
    fixtures.find((f) => f.name === "exact-incoming").wire,
  );
  const proposal = {
    connectionId: event.message.connectionId,
    context: event.context,
    requestId: "synthetic-persisted-request",
    text: "Synthetic review reply",
    reason: "manual_review",
  };
  const requests = [];
  let committed = false;
  const client = createSecretaryClient(
    createLoHttpBotTransport({
      token: "1000000000000042:synthetic-test-token",
      fetch: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        if (!committed) {
          committed = true;
          throw new TypeError("Synthetic lost response after commit");
        }
        return Response.json({
          ok: true,
          result: {
            lo_draft_id: "11111111-1111-4111-8111-111111111111",
            business_connection_id: proposal.connectionId,
            lo_conversation_id: proposal.context.conversationId,
            chat_id: proposal.context.chatId,
            lo_source_message_id: proposal.context.sourceMessageId,
            lo_revision: "2",
            state: "sent",
            mode: "review",
            text: proposal.text,
            reason: proposal.reason,
            date: 1700000000,
            expires_at: 1700086400,
            lo_secretary_bot_id: "1000000000000042",
            message_id: "9007199254741011",
          },
        });
      },
    }),
  );
  await assert.rejects(client.proposeDraft(proposal));
  const receipt = await client.proposeDraft(proposal);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(receipt.state, "sent");
  assert.equal(receipt.messageId, "9007199254741011");
});
