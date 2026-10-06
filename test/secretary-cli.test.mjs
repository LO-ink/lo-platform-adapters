import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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
