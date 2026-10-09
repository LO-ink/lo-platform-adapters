import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

test("native LO adapter has no compatibility dependency or foreign API", () => {
  const root = fileURLToPath(new URL("../packages/lo", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(manifest.peerDependencies), [
    "@lo-ink/miniapp-sdk",
  ]);
  for (const directory of ["src", "dist"]) {
    for (const name of readdirSync(join(root, directory), {
      recursive: true,
    })) {
      if (!/\.(?:ts|js)$/.test(name)) continue;
      assert.doesNotMatch(
        readFileSync(join(root, directory, name), "utf8"),
        /telegram|tgweb|web_app_|\.WebApp\b|adapter-webapp-compat|legacy/i,
        name,
      );
    }
  }
});

test("workspace and publisher contain only maintained packages", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const folders = readdirSync(join(root, "packages")).sort();
  assert.deepEqual(folders, [
    "bot-http-lo",
    "compat",
    "lo",
    "telegram",
    "telegram-to-lo",
    "vk",
  ]);
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const declared = JSON.parse(
    workflow.match(/package-paths: '([^']+)'/)[1],
  ).sort();
  assert.deepEqual(declared, folders.map((name) => `packages/${name}`).sort());
  const lock = JSON.parse(
    readFileSync(join(root, "package-lock.json"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(lock.packages)
      .filter((name) => /^packages\/[^/]+$/.test(name))
      .sort(),
    declared,
  );
});
