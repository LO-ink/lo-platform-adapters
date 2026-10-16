import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const notice =
  "Native secretary review example is retired; preserve old state and use bot-owned approval.";
test("retired CLI refuses valid and invalid legacy setups without network or state changes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lo-secretary-cli-retired-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, "state.json");
  const before =
    '{"schema":1,"jobs":[{"requestId":"original","outcome":"unknown"}]}';
  await writeFile(state, before, { mode: 0o600 });
  await writeFile(`${state}.lock`, "existing synthetic lock", { mode: 0o600 });
  const token = "42:synthetic-test-token";
  const valid = { LO_BOT_TOKEN: token, LO_SECRETARY_STATE: state };
  const guard = join(directory, "guard.mjs");
  await writeFile(
    guard,
    'globalThis.fetch = () => { process.stderr.write("UNEXPECTED_NETWORK"); throw new Error("No network expected"); };',
  );
  for (const configuration of [
    {},
    valid,
    { ...valid, LO_SECRETARY_MODE: "poll" },
    { ...valid, LO_SECRETARY_MODE: "webhook", LO_WEBHOOK_SECRET: "synthetic" },
    { ...valid, LO_SECRETARY_AUTO_CHATS: "not-json", PORT: "0" },
    { ...valid, LO_SECRETARY_STATE: join(directory, "missing", "state.json") },
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        guard,
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
    assert.equal(result.stderr.trim(), notice);
    assert.equal(result.stderr.includes(token), false);
    assert.equal(await readFile(state, "utf8"), before);
    assert.equal(
      await readFile(`${state}.lock`, "utf8"),
      "existing synthetic lock",
    );
    assert.deepEqual((await readdir(directory)).sort(), [
      "guard.mjs",
      "state.json",
      "state.json.lock",
    ]);
  }
});
