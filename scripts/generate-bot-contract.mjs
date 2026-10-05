import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { createHash } from "node:crypto";

const source = process.argv[2],
  sha = process.argv[3];
if (!source || !/^[a-f0-9]{40}$/.test(sha ?? ""))
  throw new Error(
    "Usage: node scripts/generate-bot-contract.mjs <server-botmethod-directory> <server-sha> [--check] [--allow-working-tree]",
  );
const service = resolve(source, "../../..");
const generator = ["main", "extract", "manifest"].map((name) =>
  resolve(service, "cmd/bot_contract", name + ".go"),
);
const result = spawnSync(
  "go",
  ["run", ...generator, "--source", resolve(source)],
  { encoding: "utf8" },
);
if (result.status !== 0) throw new Error(result.stderr);
const manifest = JSON.parse(result.stdout);
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort())
      : item,
  );
if (
  canonical(
    JSON.parse(readFileSync(resolve(service, "contract.json"), "utf8")),
  ) !== canonical(manifest)
)
  throw new Error(
    "Server's packaged contract differs from its source; regenerate it in messenger first.",
  );
const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: service,
  encoding: "utf8",
});
if (gitRoot.status !== 0)
  throw new Error("Server source must be a Git checkout.");
const root = gitRoot.stdout.trim();
const servicePath = relative(root, service).split("\\").join("/");
const sourcePaths = spawnSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    servicePath,
  ],
  { cwd: root, encoding: "utf8" },
);
if (sourcePaths.status !== 0)
  throw new Error("Cannot enumerate server source provenance.");
for (const path of sourcePaths.stdout.split("\0").filter(Boolean)) {
  if (!path.endsWith(".go") || path.endsWith("_test.go")) continue;
  const absolute = resolve(root, path);
  const key = relative(resolve(source), absolute).split("\\").join("/");
  manifest.source.files[key] = createHash("sha256")
    .update(readFileSync(absolute))
    .digest("hex");
}
let dirty = false;
for (const [path, digest] of Object.entries(manifest.source.files)) {
  const repositoryPath = relative(gitRoot.stdout.trim(), resolve(source, path))
    .split("\\")
    .join("/");
  const committed = spawnSync("git", ["show", `${sha}:${repositoryPath}`], {
    cwd: service,
  });
  if (
    committed.status !== 0 ||
    createHash("sha256").update(committed.stdout).digest("hex") !== digest
  )
    dirty = true;
}
if (dirty && !process.argv.includes("--allow-working-tree"))
  throw new Error(
    "Server sources differ from the specified commit. Commit approved changes first, or use --allow-working-tree for local verification.",
  );
if (dirty) {
  manifest.source.commit = null;
  manifest.source.baseCommit = sha;
  manifest.source.status = "working-tree";
  manifest.source.fingerprint = createHash("sha256")
    .update(canonical(manifest.source.files))
    .digest("hex");
} else manifest.source.commit = sha;
const body = JSON.stringify(manifest, null, 2) + "\n";
for (const target of [
  "contracts/lo-bot-api.json",
  "packages/bot-http-lo/contract.json",
  "python/lo-aiogram/src/lo_aiogram/contract.json",
  "python/lo-bot-api-emulator/src/lo_bot_api_emulator/contract.json",
]) {
  if (process.argv.includes("--check")) {
    if (
      canonical(JSON.parse(readFileSync(target, "utf8"))) !==
      canonical(manifest)
    )
      throw new Error(`Server contract drift: ${target}`);
  } else {
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, body);
  }
}
console.log(
  `Server contract: ${Object.keys(manifest.methods).length} methods with extracted allow-lists and limits.`,
);
