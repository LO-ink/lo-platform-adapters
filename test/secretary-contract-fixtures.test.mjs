import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
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
