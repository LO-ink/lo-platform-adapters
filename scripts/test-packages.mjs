import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "lo-adapter-packages-"));
const run = (file, args, cwd = root) =>
  execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const packages = [
  "compat",
  "lo",
  "lo-legacy",
  "telegram",
  "telegram-to-lo",
  "bot-http-lo",
  "vk",
];
try {
  const archives = [
    join(root, "vendor/lo-ink-miniapp-sdk-0.20.0.tgz"),
    join(root, "packages/bot-http-lo/vendor/lo-ink-bot-sdk-0.3.0.tgz"),
  ];
  for (const folder of packages) {
    const manifest = JSON.parse(
      readFileSync(join(root, "packages", folder, "package.json")),
    );
    run("npm", [
      "pack",
      "--workspace",
      manifest.name,
      "--pack-destination",
      temp,
      "--cache",
      join(temp, "cache"),
      "--silent",
    ]);
    const archive = join(
      temp,
      `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`,
    );
    const files = run("tar", ["-tzf", archive]).split("\n");
    assert.ok(files.includes("package/LICENSE"));
    assert.ok(files.includes("package/dist/index.js"));
    assert.ok(files.includes("package/dist/index.d.ts"));
    assert.ok(
      !files.some(
        (file) => file.includes("node_modules/") || file.includes("vendor/"),
      ),
    );
    archives.push(archive);
  }
  // Test the native installation independently: a full workspace can hide a
  // missing dependency or accidental compatibility import.
  const nativeConsumer = join(temp, "native-consumer");
  mkdirSync(nativeConsumer);
  writeFileSync(
    join(nativeConsumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const nativeManifest = JSON.parse(
    readFileSync(join(root, "packages/lo/package.json"), "utf8"),
  );
  run(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      join(temp, "cache"),
      archives[0],
      join(temp, `lo-ink-adapter-lo-${nativeManifest.version}.tgz`),
    ],
    nativeConsumer,
  );
  assert.deepEqual(
    readdirSync(join(nativeConsumer, "node_modules/@lo-ink")).sort(),
    ["adapter-lo", "miniapp-sdk"],
  );
  writeFileSync(
    join(nativeConsumer, "check.mjs"),
    `
import { createMiniAppClient } from '@lo-ink/miniapp-sdk';
import { createAdapter } from '@lo-ink/adapter-lo';
if (typeof createMiniAppClient !== 'function' || createAdapter() !== null) throw new Error('Native package boundary failed');
`,
  );
  run(process.execPath, ["check.mjs"], nativeConsumer);
  const consumer = join(temp, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  run(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--cache",
      join(temp, "cache"),
      ...archives,
    ],
    consumer,
  );
  for (const name of ["@vkontakte/vk-bridge", "@swc/helpers", "tslib"]) {
    const destination = join(consumer, "node_modules", name);
    if (name.includes("/"))
      mkdirSync(join(consumer, "node_modules", name.split("/")[0]), {
        recursive: true,
      });
    symlinkSync(join(root, "node_modules", name), destination, "dir");
  }
  writeFileSync(
    join(consumer, "check.mjs"),
    `
import { createMiniAppClient } from '@lo-ink/miniapp-sdk';
import { createBotClient } from '@lo-ink/bot-sdk';
import { createAdapter as createLo } from '@lo-ink/adapter-lo';
import { createAdapter as createLegacyLo } from '@lo-ink/adapter-lo-legacy';
import { installTelegramCompatibility } from '@lo-ink/adapter-telegram-to-lo';
import { createAdapter as createTelegram } from '@lo-ink/adapter-telegram';
import { detectAdapter as detectVk } from '@lo-ink/adapter-vk';
import { createLoHttpBotTransport } from '@lo-ink/bot-http-lo';
if (typeof createMiniAppClient !== 'function' || typeof createBotClient !== 'function' || typeof createLoHttpBotTransport !== 'function') throw new Error('Package export missing');
if (createLo() !== null || createLegacyLo() !== null || installTelegramCompatibility() !== null || createTelegram() !== null || await detectVk() !== null) throw new Error('SSR discovery must be inert');
`,
  );
  run(process.execPath, ["--preserve-symlinks", "check.mjs"], consumer);
  writeFileSync(
    join(consumer, "check.ts"),
    `
import { createMiniAppClient } from '@lo-ink/miniapp-sdk';
import { createAdapter as createLo } from '@lo-ink/adapter-lo';
import { createAdapter as createLegacyLo } from '@lo-ink/adapter-lo-legacy';
import { installTelegramCompatibility } from '@lo-ink/adapter-telegram-to-lo';
import { createAdapter as createTelegram } from '@lo-ink/adapter-telegram';
import { createAdapter as createVk } from '@lo-ink/adapter-vk';
import { createBotClient } from '@lo-ink/bot-sdk';
import { createLoHttpBotTransport } from '@lo-ink/bot-http-lo';
const lo = createLo(); if (lo) createMiniAppClient(lo);
const legacy = createLegacyLo(); if (legacy) createMiniAppClient(legacy);
const migration = installTelegramCompatibility(); migration?.dispose();
const telegram = createTelegram(); if (telegram) createMiniAppClient(telegram);
async function vk() { createMiniAppClient(await createVk()); }
const bot = createBotClient(createLoHttpBotTransport({ token: '1:fixture' }));
void bot; void vk;
`,
  );
  for (const resolution of ["NodeNext", "Bundler"]) {
    run(
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
      consumer,
    );
  }
  console.log(
    "Packed adapters: isolated ESM/SSR imports, NodeNext/Bundler declarations, licenses and archive boundaries pass.",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
