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
const temp = mkdtempSync(join(tmpdir(), "lo-external-peers-"));
const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, stdio: "inherit", timeout: 120_000 });
const npm = (args, cwd = root) => run("npm", args, cwd);
const manifests = Object.fromEntries(
  ["compat", "telegram", "vk"].map((name) => [
    name,
    JSON.parse(readFileSync(join(root, "packages", name, "package.json"))),
  ]),
);
try {
  const archives = {};
  for (const name of ["telegram", "vk"]) {
    const manifest = manifests[name];
    npm([
      "pack",
      "--workspace",
      manifest.name,
      "--pack-destination",
      temp,
      "--silent",
    ]);
    archives[name] = join(
      temp,
      `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`,
    );
  }
  // 0.20.1 is the first published 0.20 SDK; 0.20.0 does not exist.
  const rows = [
    ["telegram", ["0.19.2", "0.20.1", "0.21.0", "0.22.0", "0.23.0"]],
    ["vk", ["0.19.0", "0.20.1", "0.21.0", "0.22.0", "0.23.0"]],
  ];
  for (const [name, versions] of rows) {
    for (const version of versions) {
      const consumer = join(temp, `${name}-${version}`);
      mkdirSync(consumer);
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({ private: true, type: "module" }),
      );
      npm(
        [
          "install",
          "--ignore-scripts",
          "--strict-peer-deps",
          "--engine-strict",
          "--no-audit",
          "--no-fund",
          "--cache",
          join(temp, "cache"),
          `@lo-ink/miniapp-sdk@${version}`,
          archives[name],
          ...(name === "vk" ? ["@vkontakte/vk-bridge@3.0.2"] : []),
        ],
        consumer,
      );
      const installed = (pkg) =>
        JSON.parse(
          readFileSync(join(consumer, "node_modules", pkg, "package.json")),
        );
      assert.equal(installed("@lo-ink/miniapp-sdk").version, version);
      assert.equal(
        installed(manifests[name].name).version,
        manifests[name].version,
      );
      if (name === "telegram")
        assert.equal(
          installed("@lo-ink/adapter-webapp-compat").version,
          manifests.compat.version,
        );
      npm(["ls", "--all"], consumer);
      const suites =
        name === "telegram"
          ? ["test/adapters.test.mjs", "test/webapp-contract.test.mjs"]
          : ["packages/vk/test/adapter.test.mjs"];
      for (const [index, source] of suites.entries()) {
        const suite = readFileSync(join(root, source), "utf8")
          .replaceAll(
            '"../packages/compat/dist/index.js"',
            '"@lo-ink/adapter-webapp-compat"',
          )
          .replaceAll(
            '"../packages/telegram/dist/index.js"',
            '"@lo-ink/adapter-telegram"',
          )
          .replaceAll('"../dist/index.js"', '"@lo-ink/adapter-vk"');
        const path = `protocol-${index}.test.mjs`;
        writeFileSync(join(consumer, path), suite);
        run(
          process.execPath,
          ["--test", "--test-timeout=10000", path],
          consumer,
        );
      }
      writeFileSync(
        join(consumer, "ssr.mjs"),
        `import assert from 'node:assert/strict';
assert.equal(typeof window,'undefined');
assert.equal(typeof document,'undefined');
for (const name of ['Telegram','VK','LO'])
 Object.defineProperty(globalThis,name,{configurable:true,get(){throw Error('SSR global access: '+name);}});
const adapter=await import(${JSON.stringify(manifests[name].name)});
assert.equal(typeof adapter.createAdapter,'function');
`,
      );
      run(process.execPath, ["ssr.mjs"], consumer);
      writeFileSync(
        join(consumer, "check.ts"),
        `import { createMiniAppClient, type MiniAppAdapter } from '@lo-ink/miniapp-sdk';
import { createAdapter } from ${JSON.stringify(manifests[name].name)};
${name === "telegram" ? "const adapter=createAdapter({Telegram:{WebApp:{initData:'synthetic',version:'9.6'}}});" : "const adapter=await createAdapter({launchData:'opaque'});"}
if(adapter){const value:MiniAppAdapter=adapter;const client=createMiniAppClient(value);void client.call('ready',undefined);client.dispose();}
`,
      );
      for (const resolution of ["NodeNext", "Bundler"])
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
      console.log(
        `External packed protocol/types/SSR passed: ${name} SDK ${version}`,
      );
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
