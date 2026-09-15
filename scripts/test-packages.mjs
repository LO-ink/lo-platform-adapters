import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
const packages = ["compat", "lo", "telegram", "bot-http-lo", "vk"];
try {
  const archives = [
    join(root, "vendor/lo-miniapp-sdk-0.19.0.tgz"),
    join(root, "packages/bot-http-lo/vendor/lo-bot-sdk-0.1.0.tgz"),
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
import { createMiniAppClient } from '@lo/miniapp-sdk';
import { createBotClient } from '@lo/bot-sdk';
import { createAdapter as createLo } from '@lo/adapter-lo';
import { createAdapter as createTelegram } from '@lo/adapter-telegram';
import { detectAdapter as detectVk } from '@lo/adapter-vk';
import { createLoHttpBotTransport } from '@lo/bot-http-lo';
if (typeof createMiniAppClient !== 'function' || typeof createBotClient !== 'function' || typeof createLoHttpBotTransport !== 'function') throw new Error('Package export missing');
if (createLo() !== null || createTelegram() !== null || await detectVk() !== null) throw new Error('SSR discovery must be inert');
`,
  );
  run(process.execPath, ["--preserve-symlinks", "check.mjs"], consumer);
  writeFileSync(
    join(consumer, "check.ts"),
    `
import { createMiniAppClient } from '@lo/miniapp-sdk';
import { createAdapter as createLo } from '@lo/adapter-lo';
import { createAdapter as createTelegram } from '@lo/adapter-telegram';
import { createAdapter as createVk } from '@lo/adapter-vk';
import { createBotClient } from '@lo/bot-sdk';
import { createLoHttpBotTransport } from '@lo/bot-http-lo';
const lo = createLo(); if (lo) createMiniAppClient(lo);
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
