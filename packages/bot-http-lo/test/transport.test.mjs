import test from "node:test";
import assert from "node:assert/strict";
import * as sdk from "@lo-ink/bot-sdk";
import * as compatibility from "../dist/index.js";

test("HTTP compatibility exports use the canonical Bot SDK", () => {
  for (const name of [
    "createLoHttpBotTransport",
    "decodeLoBotUpdate",
    "parseLoBotWebhookUpdate",
    "HttpBotError",
  ])
    assert.equal(compatibility[name], sdk[name], name);
});

test("injected HTTP transport remains usable by the generic SDK client", async () => {
  const client = sdk.createBotClient(
    compatibility.createLoHttpBotTransport({
      token: "42:test-token",
      fetch: async () =>
        Response.json({
          ok: true,
          result: {
            id: 42,
            is_bot: true,
            first_name: "Example",
            can_join_groups: true,
            can_read_all_group_messages: false,
            supports_inline_queries: false,
          },
        }),
    }),
  );
  assert.equal((await client.getIdentity()).id, "42");
});
