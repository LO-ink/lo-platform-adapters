import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("Secretary CLI rejects incomplete and invalid configuration before creating private state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lo-secretary-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "state.json");
  const token = "42:synthetic-test-token";
  const valid = { LO_BOT_TOKEN: token, LO_SECRETARY_STATE: state };
  const cases = [
    {},
    { LO_BOT_TOKEN: token },
    { ...valid, LO_SECRETARY_MODE: "invalid" },
    { ...valid, LO_SECRETARY_AUTO_CHATS: "invalid-json" },
    { ...valid, LO_SECRETARY_AUTO_CHATS: "{}" },
    {
      ...valid,
      LO_SECRETARY_AUTO_CHATS: '[{"connectionId":"invalid","chatId":"42"}]',
    },
    { ...valid, LO_SECRETARY_MODE: "webhook" },
    { ...valid, PORT: "0" },
  ];
  for (const configuration of cases) {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../examples/secretary/run.mjs", import.meta.url),
        ),
      ],
      {
        env: {
          ...configuration,
          ...(process.env.NODE_V8_COVERAGE
            ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE }
            : {}),
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr.trim(),
      "Secretary reference bot stopped; inspect configuration and private state.",
    );
    assert.equal(result.stderr.includes(token), false);
    await assert.rejects(access(state), { code: "ENOENT" });
  }
});

test("Secretary configuration preserves canonical positive int64 chat strings", () => {
  const source = readFileSync(
    new URL("../examples/secretary/run.mjs", import.meta.url),
    "utf8",
  );
  const configSource = source.slice(
    source.indexOf("function config()"),
    source.indexOf("async function main()"),
  );
  assert.ok(configSource.startsWith("function config()"));
  function configure(chatId) {
    return runInNewContext(configSource + "\nconfig()", {
      process: {
        env: {
          LO_BOT_TOKEN: "synthetic",
          LO_SECRETARY_STATE: "unused-state.json",
          LO_SECRETARY_AUTO_CHATS: JSON.stringify([
            { connectionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", chatId },
          ]),
        },
      },
    });
  }
  for (const id of [
    "1",
    "999999999999999",
    "9007199254740991",
    "9007199254740993",
    "9223372036854775807",
  ])
    assert.equal(configure(id).bindings[0].chatId, id);
  for (const id of [
    "9223372036854775808",
    "10000000000000000000",
    "0",
    "-1",
    "01",
    "1.0",
    "+1",
    " 1",
    "1 ",
    "1e3",
    "",
    1,
    9007199254740992,
    null,
    {},
    [],
  ])
    assert.throws(() => configure(id), /Invalid explicit per-chat opt-in/);
});
