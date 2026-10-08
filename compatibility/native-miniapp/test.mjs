import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const modules = join(fixture, "node_modules");
const manifest = JSON.parse(readFileSync(join(fixture, "package.json")));
const installed = JSON.parse(
  readFileSync(join(modules, "@lo-ink/miniapp-sdk/package.json")),
);
assert.equal(installed.version, manifest.dependencies["@lo-ink/miniapp-sdk"]);
assert.equal(installed.engines.node, ">=22.13");

const directory = mkdtempSync(join(tmpdir(), "lo-native-current-consumer-"));
try {
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  symlinkSync(modules, join(directory, "node_modules"), "dir");
  for (const name of ["vanilla.ts", "lifecycle.ts"])
    copyFileSync(join(root, "examples", name), join(directory, name));
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "vanilla.ts",
      "lifecycle.ts",
    ],
    { cwd: directory, stdio: "inherit" },
  );

  const output = execFileSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern=^(vanilla/lo-native |vanilla recreates |teardown during native readiness )",
      "test/examples.test.mjs",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, LO_NATIVE_EXAMPLE_MODULES: modules },
    },
  );
  // A renamed or removed case must not turn this into an empty successful run.
  assert.match(output, /^# tests 3$/m);
  assert.match(output, /^# pass 3$/m);
  assert.match(output, /^# fail 0$/m);
  process.stdout.write(output);
  console.log(
    `Native examples verified against Mini App SDK ${installed.version}`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
