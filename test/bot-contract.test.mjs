import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("published transports and Python packages share the generated server contract", () => {
  const reference = readFileSync(
    new URL("../contracts/lo-bot-api.json", import.meta.url),
    "utf8",
  );
  for (const path of [
    "../packages/bot-http-lo/contract.json",
    "../python/lo-aiogram/src/lo_aiogram/contract.json",
    "../python/lo-bot-api-emulator/src/lo_bot_api_emulator/contract.json",
  ])
    assert.equal(
      readFileSync(new URL(path, import.meta.url), "utf8"),
      reference,
    );
  const contract = JSON.parse(reference);
  assert.equal(Object.hasOwn(contract, "source"), false);
  assert.deepEqual(contract.methods.sendVideo.uploadOnly, [
    "duration",
    "width",
    "height",
    "thumbnail",
  ]);
  assert.equal(contract.methods.sendChatAction.implemented, true);
  assert.ok(
    contract.methods.sendMessage.parameters.includes("reply_parameters"),
  );
  assert.ok(
    contract.methods.sendMediaGroup.parameters.includes("disable_notification"),
  );
  assert.deepEqual(contract.inputMedia.types, ["photo", "document"]);
  assert.equal(contract.limits.textUtf16, 4096);
});
