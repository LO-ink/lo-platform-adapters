import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const platform = process.platform;
const architecture = { arm64: "arm64", x64: "x64" }[process.arch];
const checksums = {
  darwin_arm64:
    "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  darwin_x64:
    "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  linux_arm64:
    "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  linux_x64: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
};
const checksum = checksums[`${platform}_${architecture}`];
if (!checksum)
  throw new Error("Secret scanning requires Linux or macOS on arm64 or x64");
const temp = mkdtempSync(join(tmpdir(), "lo-secrets-"));
try {
  const response = await fetch(
    `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_${platform}_${architecture}.tar.gz`,
  );
  if (!response.ok)
    throw new Error(`Cannot download scanner: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== checksum)
    throw new Error("Secret scanner checksum mismatch");
  writeFileSync(join(temp, "scanner.tar.gz"), archive);
  execFileSync("tar", [
    "-xzf",
    join(temp, "scanner.tar.gz"),
    "-C",
    temp,
    "gitleaks",
  ]);
  const config = resolve(".gitleaks.toml");
  const fixture = join(temp, "fixture");
  mkdirSync(fixture);
  const candidate = `123456:${"A".repeat(43)}`;
  for (const [value, expected] of [
    [candidate, 1],
    [`${candidate}A`, 0],
  ]) {
    writeFileSync(
      join(fixture, "credential.json"),
      JSON.stringify({ credential: value }),
    );
    const probe = spawnSync(
      join(temp, "gitleaks"),
      [
        "dir",
        fixture,
        "--config",
        config,
        "--redact",
        "--no-banner",
        "--report-format",
        "json",
        "--report-path",
        join(temp, "probe.json"),
      ],
      { encoding: "utf8" },
    );
    if (probe.error || probe.signal || probe.status !== expected)
      throw new Error("LO credential scanner regression failed");
    if (
      expected === 1 &&
      !JSON.parse(readFileSync(join(temp, "probe.json"), "utf8")).some(
        (finding) => finding.RuleID === "lo-bot-token",
      )
    )
      throw new Error("LO credential rule is not active");
  }
  const result = spawnSync(
    join(temp, "gitleaks"),
    ["dir", ".", "--redact", "--no-banner"],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.signal)
    throw new Error(`Secret scanner terminated: ${result.signal}`);
  process.exitCode = result.status;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
