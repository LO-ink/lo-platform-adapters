import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSecretaryState } from "../examples/secretary/state.mjs";
import { createReferenceSecretary } from "../examples/secretary/reference.mjs";

test("retired processor refuses before reading settings or contacting any client", () => {
  let reads = 0,
    calls = 0;
  const settings = {
    get store() {
      reads++;
      throw new Error("No legacy store access");
    },
    get client() {
      reads++;
      return {
        proposeDraft() {
          calls++;
        },
        sendText() {
          calls++;
        },
      };
    },
  };
  for (const input of [undefined, null, {}, settings])
    assert.throws(
      () => createReferenceSecretary(input),
      (error) => error.code === "unsupported",
    );
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test("retired state opener preserves exact old unknown receipts, locks and temporary files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lo-secretary-retired-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  const records = {
    "state.json": JSON.stringify({
      schema: 1,
      botId: "1000000000000042",
      offset: "12",
      jobs: [
        {
          status: "pending",
          requestId: "original",
          draftId: "old-draft",
          outcome: "unknown",
        },
        {
          status: "drafted",
          requestId: "second-original",
          draftId: "second-draft",
        },
      ],
    }),
    "state.json.lock": "synthetic old PID",
    "state.json.tmp-old": "synthetic uncertain write",
  };
  for (const [name, bytes] of Object.entries(records))
    await writeFile(join(directory, name), bytes, { mode: 0o600 });
  await assert.rejects(
    openSecretaryState(path, "1000000000000042"),
    (error) => error.code === "unsupported",
  );
  assert.deepEqual(
    (await readdir(directory)).sort(),
    Object.keys(records).sort(),
  );
  for (const [name, bytes] of Object.entries(records))
    assert.equal(await readFile(join(directory, name), "utf8"), bytes);
});
