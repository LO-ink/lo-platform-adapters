import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const generator = fileURLToPath(
  new URL("../scripts/generate-bot-contract.mjs", import.meta.url),
);
const targets = [
  "contracts/lo-bot-api.json",
  "packages/bot-http-lo/contract.json",
  "python/lo-aiogram/src/lo_aiogram/contract.json",
  "python/lo-bot-api-emulator/src/lo_bot_api_emulator/contract.json",
];

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "lo-contract-export-"));
  try {
    const server = join(root, "server");
    const service = join(server, "bot-service");
    const source = join(service, "controller/http/botapi");
    const output = join(root, "public");
    const bin = join(root, "bin");
    for (const path of [source, output, bin])
      mkdirSync(path, { recursive: true });
    const method = "package botapi\n";
    writeFileSync(join(source, "method.go"), method);
    const payload = {
      methods: { getMe: { status: 200 } },
      limits: { textUtf16: 4096 },
    };
    const manifest = {
      ...payload,
      source: {
        repository: "private-fixture",
        files: {
          "method.go": createHash("sha256").update(method).digest("hex"),
        },
      },
    };
    const contract = join(service, "contract.json");
    writeFileSync(contract, JSON.stringify(manifest));
    const git = (...args) =>
      execFileSync("git", ["-C", server, ...args], { encoding: "utf8" });
    git("init", "--quiet");
    git("add", ".");
    git(
      "-c",
      "user.name=Contract fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    const revision = git("rev-parse", "HEAD").trim();
    // Only the Go extractor is controlled. The production exporter performs
    // its real packaged-contract comparison and Git/source hash checks.
    writeFileSync(join(bin, "go"), '#!/bin/sh\ncat "$LO_TEST_CONTRACT"\n', {
      mode: 0o755,
    });
    const invoke = (...flags) =>
      spawnSync(process.execPath, [generator, source, revision, ...flags], {
        cwd: output,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: bin + delimiter + process.env.PATH,
          LO_TEST_CONTRACT: contract,
        },
      });
    run({ source, output, payload, invoke });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("verified export preserves all public fields and omits private source", () => {
  fixture(({ output, payload, invoke }) => {
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    for (const target of targets)
      assert.deepEqual(JSON.parse(readFileSync(join(output, target))), payload);
    assert.equal(invoke("--check").status, 0);
  });
});

test("dirty source cannot overwrite any public target, including with the retired flag", () => {
  fixture(({ source, output, invoke }) => {
    for (const target of targets) {
      const path = join(output, target);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "preserved public target\n");
    }
    writeFileSync(join(source, "method.go"), "package changed\n");
    for (const flags of [[], ["--allow-working-tree"]]) {
      const result = invoke(...flags);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /specified commit|Usage:/);
      for (const target of targets)
        assert.equal(
          readFileSync(join(output, target), "utf8"),
          "preserved public target\n",
        );
    }
  });
});
