import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  download,
  limits,
  readBounded,
  runBounded,
  ScannerFailure,
} from "./secret-scanner-runtime.mjs";

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
const controller = new AbortController();
let interrupted,
  cleanupDebt = false;
const interrupt = (signal) => {
  interrupted ||= signal;
  controller.abort();
};
const onTerm = () => interrupt("SIGTERM");
const onInt = () => interrupt("SIGINT");
process.on("SIGTERM", onTerm);
process.on("SIGINT", onInt);
try {
  const archive = await download(
    `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_${platform}_${architecture}.tar.gz`,
    checksum,
    { signal: controller.signal },
  );
  writeFileSync(join(temp, "scanner.tar.gz"), archive, {
    flag: "wx",
    mode: 0o600,
  });
  const extraction = await runBounded(
    process.execPath,
    [
      fileURLToPath(new URL("./secret-scanner-runtime.mjs", import.meta.url)),
      "--extract",
      join(temp, "scanner.tar.gz"),
      join(temp, "gitleaks"),
    ],
    { signal: controller.signal, timeoutMs: limits.extractionMs },
  );
  if (extraction.status !== 0) throw new ScannerFailure("archive refused");
  const config = resolve(".gitleaks.toml");
  const fixture = join(temp, "fixture");
  mkdirSync(fixture, { mode: 0o700 });
  const candidate = `123456:${"A".repeat(43)}`;
  for (const [value, expected] of [
    [candidate, 1],
    [`${candidate}A`, 0],
  ]) {
    writeFileSync(
      join(fixture, "credential.json"),
      JSON.stringify({ credential: value }),
      { mode: 0o600 },
    );
    const report = join(temp, "probe.json");
    const probe = await runBounded(
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
        report,
      ],
      { signal: controller.signal },
    );
    if (probe.status !== expected)
      throw new ScannerFailure("LO credential regression failed");
    if (expected === 1) {
      const findings = JSON.parse(
        readBounded(report, limits.reportBytes).toString("utf8"),
      );
      if (
        !Array.isArray(findings) ||
        !findings.some((finding) => finding?.RuleID === "lo-bot-token")
      )
        throw new ScannerFailure("LO credential report refused");
      unlinkSync(report);
    }
  }
  const result = await runBounded(
    join(temp, "gitleaks"),
    ["dir", ".", "--redact", "--no-banner"],
    { signal: controller.signal },
  );
  if (result.status !== 0) {
    process.stderr.write(
      "Secret scanner rejected the source tree. Review findings locally; raw scanner output is not printed.\n",
    );
    process.exitCode = result.status;
  } else {
    process.stdout.write("Secret scanner passed.\n");
  }
} catch (error) {
  cleanupDebt = error instanceof ScannerFailure && error.cleanupDebt;
  process.stderr.write(
    error instanceof ScannerFailure
      ? `${error.message}\n`
      : "Secret scanner: operation failed\n",
  );
  process.exitCode = 1;
} finally {
  // A still-owned process may retain these paths: never erase them on debt.
  if (!cleanupDebt) {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch {
      process.stderr.write("Secret scanner: cleanup failed\n");
      process.exitCode = 1;
    }
  }
  process.removeListener("SIGTERM", onTerm);
  process.removeListener("SIGINT", onInt);
  if (interrupted) process.exitCode = interrupted === "SIGTERM" ? 143 : 130;
}
