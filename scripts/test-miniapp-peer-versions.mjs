import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "lo-miniapp-peers-"));
const run = (args, cwd = root) =>
  execFileSync("npm", args, { cwd, stdio: "inherit" });
try {
  const archives = [];
  for (const folder of ["compat", "lo", "lo-legacy"]) {
    const manifest = JSON.parse(
      readFileSync(join(root, "packages", folder, "package.json")),
    );
    run([
      "pack",
      "--workspace",
      manifest.name,
      "--pack-destination",
      temp,
      "--silent",
    ]);
    archives.push(
      join(
        temp,
        `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`,
      ),
    );
  }
  for (const version of ["0.22.3", "0.23.0"]) {
    const consumer = join(temp, version);
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    run(
      [
        "install",
        "--ignore-scripts",
        "--strict-peer-deps",
        "--no-audit",
        "--no-fund",
        `@lo-ink/miniapp-sdk@${version}`,
        ...archives,
      ],
      consumer,
    );
    const installed = JSON.parse(
      readFileSync(
        join(consumer, "node_modules/@lo-ink/miniapp-sdk/package.json"),
      ),
    );
    assert.equal(installed.version, version);
    run(["ls", "--all"], consumer);
    const legacyManifest = JSON.parse(
      readFileSync(
        join(consumer, "node_modules/@lo-ink/adapter-lo-legacy/package.json"),
      ),
    );
    const compatManifest = JSON.parse(
      readFileSync(
        join(
          consumer,
          "node_modules/@lo-ink/adapter-webapp-compat/package.json",
        ),
      ),
    );
    assert.equal(
      legacyManifest.dependencies["@lo-ink/adapter-webapp-compat"],
      "0.20.4",
    );
    assert.equal(compatManifest.version, "0.20.4");
    const suite = readFileSync(
      join(root, "packages/lo/test/native.test.mjs"),
      "utf8",
    )
      .replaceAll('"../dist/index.js"', '"@lo-ink/adapter-lo"')
      .replaceAll(
        '"../../lo-legacy/dist/index.js"',
        '"@lo-ink/adapter-lo-legacy"',
      );
    writeFileSync(join(consumer, "native.test.mjs"), suite);
    execFileSync(process.execPath, ["--test", "native.test.mjs"], {
      cwd: consumer,
      stdio: "inherit",
    });
    const legacySuite = readFileSync(
      join(root, "test/webapp-contract.test.mjs"),
      "utf8",
    ).replaceAll(
      '"../packages/lo-legacy/dist/index.js"',
      '"@lo-ink/adapter-lo-legacy"',
    );
    writeFileSync(join(consumer, "webapp-contract.test.mjs"), legacySuite);
    execFileSync(process.execPath, ["--test", "webapp-contract.test.mjs"], {
      cwd: consumer,
      stdio: "inherit",
    });
    writeFileSync(
      join(consumer, "check.ts"),
      `
import { createMiniAppClient, createNativeAdapter } from '@lo-ink/miniapp-sdk';
import { createAdapter } from '@lo-ink/adapter-lo';
import { createAdapter as createLegacy } from '@lo-ink/adapter-lo-legacy';
const native: typeof createNativeAdapter = createAdapter;
const legacy = createLegacy();
if (legacy) createMiniAppClient(legacy);
void native;
`,
    );
    for (const resolution of ["NodeNext", "Bundler"]) {
      execFileSync(
        process.execPath,
        [
          join(root, "node_modules/typescript/bin/tsc"),
          "--noEmit",
          "--strict",
          "--target",
          "ES2022",
          "--module",
          resolution === "NodeNext" ? "NodeNext" : "ESNext",
          "--moduleResolution",
          resolution,
          "check.ts",
        ],
        { cwd: consumer, stdio: "inherit" },
      );
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
