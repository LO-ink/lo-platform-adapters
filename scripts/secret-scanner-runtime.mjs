import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const limits = Object.freeze({
  archiveBytes: 32 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  executableBytes: 64 * 1024 * 1024,
  members: 128,
  downloadMs: 120000,
  extractionMs: 10000,
  scannerMs: 120000,
  streamBytes: 1024 * 1024,
  reportBytes: 1024 * 1024,
  cleanupMs: 3000,
});

export class ScannerFailure extends Error {
  constructor(code, cleanupDebt = false) {
    super(`Secret scanner: ${code}`);
    this.code = code;
    this.cleanupDebt = cleanupDebt;
  }
}
function positive(value) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new ScannerFailure("invalid operation limit");
}
const fail = (code) => {
  throw new ScannerFailure(code);
};
const digest = (data) => createHash("sha256").update(data).digest("hex");
const hosts = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
function releaseURL(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !hosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    fail("unapproved release URL");
  return url.href;
}

export async function download(
  url,
  checksum,
  {
    signal,
    timeoutMs = limits.downloadMs,
    cap = limits.archiveBytes,
    fetchImpl = fetch,
  } = {},
) {
  positive(timeoutMs);
  positive(cap);
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    for (let redirects = 0; ; redirects++) {
      response = await fetchImpl(releaseURL(url), {
        signal: combined,
        redirect: "manual",
        headers: { "Accept-Encoding": "identity" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects >= 5 || !response.headers.get("location"))
          fail("redirect limit");
        url = new URL(response.headers.get("location"), url).href;
        continue;
      }
      break;
    }
    if (
      !response.ok ||
      !response.body ||
      ![null, "identity"].includes(response.headers.get("content-encoding"))
    )
      fail("release response refused");
    const advertised = response.headers.get("content-length");
    if (
      advertised !== null &&
      (!/^\d+$/.test(advertised) || Number(advertised) > cap)
    )
      fail("archive limit");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      if (combined.aborted) fail("download cancelled or timed out");
      size += chunk.length;
      if (size > cap) fail("archive limit");
      chunks.push(chunk);
    }
    if (combined.aborted) fail("download cancelled or timed out");
    if (advertised !== null && size !== Number(advertised))
      fail("release length mismatch");
    const archive = Buffer.concat(chunks, size);
    if (digest(archive) !== checksum) fail("checksum mismatch");
    return archive;
  } catch (error) {
    if (error instanceof ScannerFailure) throw error;
    throw new ScannerFailure("download failed or timed out");
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

export function readBounded(path, cap) {
  positive(cap);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > cap) fail("file limit or type");
    const data = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < data.length) {
      const count = readSync(fd, data, size, data.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size !== info.size) fail("file changed during read");
    return data.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

function tarText(field) {
  const end = field.indexOf(0);
  const bytes = end < 0 ? field : field.subarray(0, end);
  if (bytes.some((byte) => byte < 32 || byte > 126))
    fail("archive name encoding");
  return bytes.toString("ascii");
}
function octal(field) {
  const value = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(value)) fail("archive numeric field");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail("archive numeric limit");
  return number;
}

// No general-purpose extraction: validate every header, then write only the
// unique root executable. PAX/GNU extensions, links and device entries refuse.
export function executableFromArchive(compressed, bounds = limits) {
  if (compressed.length > bounds.archiveBytes) fail("archive limit");
  let bytes;
  try {
    bytes = gunzipSync(compressed, { maxOutputLength: bounds.expandedBytes });
  } catch {
    fail("gzip or expansion limit");
  }
  let offset = 0,
    count = 0,
    executable;
  const seen = new Set();
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        offset + 1024 > bytes.length ||
        !bytes.subarray(offset).every((byte) => byte === 0)
      )
        fail("archive terminator");
      if (!executable) fail("missing executable");
      return executable;
    }
    if (++count > bounds.members) fail("archive member limit");
    const checksum = octal(header.subarray(148, 156));
    const computed = header.reduce(
      (sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte),
      0,
    );
    if (computed !== checksum) fail("archive header checksum");
    const prefix = tarText(header.subarray(345, 500));
    const leaf = tarText(header.subarray(0, 100));
    const name = prefix ? `${prefix}/${leaf}` : leaf;
    const type = header[156];
    const directory = type === 53;
    const normalized =
      directory && name.endsWith("/") ? name.slice(0, -1) : name;
    if (
      !normalized ||
      normalized.includes("\\") ||
      normalized
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      seen.has(normalized)
    )
      fail("archive path or duplicate");
    seen.add(normalized);
    if (![0, 48, 53].includes(type)) fail("archive member type");
    const size = octal(header.subarray(124, 136));
    if (
      size > bounds.expandedBytes ||
      (directory && size !== 0) ||
      offset + 512 + Math.ceil(size / 512) * 512 > bytes.length
    )
      fail("archive member size");
    if (normalized === "gitleaks") {
      if (directory || !size || size > bounds.executableBytes)
        fail("executable type or size");
      executable = bytes.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  fail("truncated archive");
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    // Permission denial does not prove absence. Keep observing within the
    // existing cleanup deadline; only ESRCH can establish quiescence.
    if (error.code === "EPERM") return true;
    throw new ScannerFailure("cannot observe process group", true);
  }
}
function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH")
      throw new ScannerFailure("cannot terminate process group", true);
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runBounded(
  executable,
  args,
  {
    signal,
    timeoutMs = limits.scannerMs,
    cap = limits.streamBytes,
    cleanupMs = limits.cleanupMs,
  } = {},
) {
  positive(timeoutMs);
  positive(cap);
  positive(cleanupMs);
  if (signal?.aborted) fail("command cancelled");
  const child = spawn(executable, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let failure,
    spawnError,
    exit,
    closed = false;
  const chunks = { stdout: [], stderr: [] },
    sizes = { stdout: 0, stderr: 0 };
  let stopped;
  const stopping = new Promise((resolve) => {
    stopped = resolve;
  });
  const stop = (reason) => {
    stopped();
    failure ||= reason;
    if (child.pid) {
      try {
        killGroup(child.pid);
      } catch {
        failure = "process cleanup failed";
      }
    }
  };
  const exited = new Promise((resolve) => {
    child.once("error", () => {
      spawnError = true;
      resolve();
    });
    child.once("exit", (code, sig) => {
      exit = { code, signal: sig };
      resolve();
    });
  });
  child.once("close", () => {
    closed = true;
  });
  for (const stream of ["stdout", "stderr"])
    child[stream].on("data", (chunk) => {
      if (sizes[stream] + chunk.length > cap) {
        stop("command output limit");
        return;
      }
      sizes[stream] += chunk.length;
      chunks[stream].push(chunk);
    });
  const cancel = () => stop("command cancelled");
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => stop("command deadline"), timeoutMs);
  try {
    const reaped = await Promise.race([
      exited.then(() => true),
      stopping.then(async () => {
        await sleep(cleanupMs);
        return false;
      }),
    ]);
    if (!reaped) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      throw new ScannerFailure("process reap incomplete", true);
    }
    if (spawnError) fail("command could not start");
    if (groupExists(child.pid)) {
      failure ||= "lingering command descendants";
      killGroup(child.pid);
    }
    const until = performance.now() + cleanupMs;
    while ((!closed || groupExists(child.pid)) && performance.now() < until)
      await sleep(10);
    if (!closed || groupExists(child.pid))
      throw new ScannerFailure("process cleanup incomplete", true);
    if (failure) fail(failure);
    if (signal?.aborted) fail("command cancelled");
    if (exit.signal || exit.code === null) fail("command terminated");
    return {
      status: exit.code,
      stdout: Buffer.concat(chunks.stdout),
      stderr: Buffer.concat(chunks.stderr),
    };
  } catch (error) {
    if (error instanceof ScannerFailure && error.cleanupDebt) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  process.argv[2] === "--extract"
) {
  try {
    const archive = readBounded(process.argv[3], limits.archiveBytes);
    writeFileSync(process.argv[4], executableFromArchive(archive), {
      flag: "wx",
      mode: 0o700,
    });
  } catch {
    process.stderr.write("Secret scanner: archive refused\n");
    process.exitCode = 1;
  }
}
