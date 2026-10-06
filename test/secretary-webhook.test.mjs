import assert from "node:assert/strict";
import { test } from "node:test";
import { createSecretaryWebhookServer } from "../examples/secretary/webhook.mjs";

const secret = [
  "fixture",
  "secret",
  "with",
  "at",
  "least",
  "32",
  "characters",
].join("-");
async function listen(t, processUpdate) {
  const server = createSecretaryWebhookServer({ secret, processUpdate });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/secretary`;
}
const headers = {
  "content-type": "application/json",
  "x-telegram-bot-api-secret-token": secret,
};

test("webhook authenticates before decode and only acknowledges completed durable processing", async (t) => {
  let calls = 0;
  let release;
  const url = await listen(t, async () => {
    calls++;
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "x-telegram-bot-api-secret-token": `${secret}x`,
        },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(calls, 0);
  let acknowledged = false;
  const request = fetch(url, {
    method: "POST",
    headers,
    body: '{"update_id":9007199254740993,"callback_query":{"id":"opaque","from":{"id":123}}}',
  }).then((response) => {
    acknowledged = true;
    return response;
  });
  for (let i = 0; !release && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  assert.equal(acknowledged, false);
  release();
  assert.equal((await request).status, 200);
});

test("malformed updates are rejected and failed durable processing asks for replay", async (t) => {
  let calls = 0;
  const url = await listen(t, async () => {
    calls++;
    throw new Error("private state failure");
  });
  assert.equal(
    (await fetch(url, { method: "POST", headers, body: '{"update_id":1}' }))
      .status,
    503,
  );
  assert.equal(
    (await fetch(url, { method: "POST", headers, body: "not-json" })).status,
    400,
  );
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "text/plain" },
        body: "{}",
      })
    ).status,
    415,
  );
  assert.equal((await fetch(url, { method: "GET" })).status, 404);
  assert.equal(calls, 1);
});
