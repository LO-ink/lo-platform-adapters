import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  download,
  executableFromArchive,
  limits,
  readBounded,
  runBounded,
} from "./secret-scanner-runtime.mjs";

const hash = (data) => createHash("sha256").update(data).digest("hex");
const url =
  "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/archive.tar.gz";
const js = (source, options) =>
  runBounded(process.execPath, ["-e", source], options);
function tar(entries) {
  const chunks = [];
  for (const [name, data = Buffer.from("executable"), type = "0"] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "ascii");
    header.write(
      data.length.toString(8).padStart(11, "0") + "\0",
      124,
      12,
      "ascii",
    );
    header.write(type, 156, 1, "ascii");
    header.fill(32, 148, 156);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
async function server(handler, action) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = `http://127.0.0.1:${server.address().port}`;
    await action((unused, options) => fetch(address, options), address);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("bounded HTTPS release interface accepts exact bytes", async () => {
  const data = Buffer.from("archive");
  await server(
    (req, res) => res.end(data),
    async (fetchImpl) => {
      assert.deepEqual(
        await download(url, hash(data), { fetchImpl, cap: data.length }),
        data,
      );
    },
  );
});
test("real stalled headers and body expire without raw diagnostics", async () => {
  for (const headers of [false, true])
    await server(
      (req, res) => {
        if (headers) {
          res.writeHead(200);
          res.write("partial");
        }
      },
      async (fetchImpl) => {
        const start = Date.now();
        await assert.rejects(
          download(url, hash(Buffer.from("x")), { fetchImpl, timeoutMs: 60 }),
          /download/,
        );
        assert.ok(Date.now() - start < 2000);
      },
    );
});
test("actual body overflow and checksum mismatch refuse", async () => {
  await server(
    (req, res) => {
      res.writeHead(200);
      res.end("12345");
    },
    async (fetchImpl) => {
      await assert.rejects(
        download(url, hash(Buffer.from("12345")), { fetchImpl, cap: 4 }),
        /archive limit/,
      );
      await assert.rejects(
        download(url, hash(Buffer.from("wrong")), { fetchImpl }),
        /checksum/,
      );
    },
  );
});
test("abort after response headers cancels body acquisition", async () => {
  const controller = new AbortController();
  await server(
    (req, res) => {
      res.writeHead(200);
      res.write("partial");
      setTimeout(() => controller.abort(), 30);
    },
    async (fetchImpl) => {
      await assert.rejects(
        download(url, "0".repeat(64), { fetchImpl, signal: controller.signal }),
        /download/,
      );
    },
  );
});
test("unsafe redirects are rejected before the second request", async () => {
  let calls = 0;
  await assert.rejects(
    download(url, "0".repeat(64), {
      fetchImpl: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      },
    }),
    /unapproved/,
  );
  assert.equal(calls, 1);
});
test("redirect count, advertised size and encoding are bounded", async () => {
  let calls = 0;
  await assert.rejects(
    download(url, "0".repeat(64), {
      fetchImpl: async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location: url } });
      },
    }),
    /redirect limit/,
  );
  assert.equal(calls, 6);
  for (const headers of [
    { "content-length": "9999" },
    { "content-encoding": "gzip" },
  ]) {
    await assert.rejects(
      download(url, "0".repeat(64), {
        cap: 1,
        fetchImpl: async () => new Response("x", { headers }),
      }),
      /limit|refused/,
    );
  }
});
test("validated tar selects exact root executable only", () => {
  const data = Buffer.from("native executable");
  assert.deepEqual(
    executableFromArchive(
      tar([
        ["completion/gitleaks", Buffer.from("text")],
        ["gitleaks", data],
      ]),
    ),
    data,
  );
});
test("tar traversal, links, duplicate, missing root and directory refuse", () => {
  for (const entries of [
    [["../gitleaks"]],
    [["/gitleaks"]],
    [["a//gitleaks"]],
    [["gitleaks", Buffer.alloc(0), "2"]],
    [["gitleaks"], ["gitleaks"]],
    [["nested/gitleaks"]],
    [["gitleaks/", Buffer.alloc(0), "5"]],
  ])
    assert.throws(() => executableFromArchive(tar(entries)), /Secret scanner/);
});
test("gzip integrity, expanded bytes, member and executable caps refuse", () => {
  const good = tar([["gitleaks"]]);
  assert.throws(
    () => executableFromArchive(good.subarray(0, good.length - 3)),
    /gzip/,
  );
  assert.throws(
    () => executableFromArchive(good, { ...limits, expandedBytes: 512 }),
    /expansion/,
  );
  assert.throws(
    () => executableFromArchive(good, { ...limits, executableBytes: 1 }),
    /size/,
  );
  assert.throws(
    () =>
      executableFromArchive(tar([["LICENSE"], ["gitleaks"]]), {
        ...limits,
        members: 1,
      }),
    /member limit/,
  );
});
test("file/report acquisition caps and symlinks refuse", () => {
  const dir = mkdtempSync(join(tmpdir(), "scanner-model-"));
  try {
    const path = join(dir, "report");
    writeFileSync(path, "1234");
    assert.equal(readBounded(path, 4).toString(), "1234");
    assert.throws(() => readBounded(path, 3), /file limit/);
    symlinkSync(path, join(dir, "link"));
    assert.throws(() => readBounded(join(dir, "link"), 4));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("real child exact stream cap and clean/nonzero exit are distinct", async () => {
  const result = await js(
    "process.stdout.write('abcd'); process.stderr.write('efgh');",
    { cap: 4 },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), "abcd");
  assert.equal(result.stderr.toString(), "efgh");
  assert.equal((await js("process.exitCode=1")).status, 1);
});
test("real stdout and stderr overflow refuse even exit zero", async () => {
  for (const stream of ["stdout", "stderr"])
    await assert.rejects(
      js(`process.${stream}.write('x'.repeat(4096))`, { cap: 4 }),
      /output limit/,
    );
});
test("real child timeout and caller cancellation reject after join", async () => {
  await assert.rejects(
    js("setInterval(()=>{},100)", { timeoutMs: 50 }),
    /deadline/,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60);
  try {
    await assert.rejects(
      js("setInterval(()=>{},100)", { signal: controller.signal }),
      /cancelled/,
    );
  } finally {
    clearTimeout(timer);
  }
});
async function cleanupOwnedDescendant(t, dir, path) {
  const pid = Number(readFileSync(path, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  t.diagnostic(`Owned descendant PID ${pid}: cleanup started`);
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const deadline = performance.now() + 3000;
  let absent = false;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      absent = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(absent, "owned descendant cleanup remains uncertain");
  t.diagnostic(`Owned descendant PID ${pid}: absent (ESRCH)`);
  rmSync(dir, { recursive: true });
}

async function ownedDescendant(t, action) {
  const dir = mkdtempSync(join(tmpdir(), "scanner-child-"));
  const path = join(dir, "pid");
  const code = `const{spawn}=require('child_process');const{writeFileSync}=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(path)},String(c.pid));c.unref();`;
  let failure, cleanupFailure;
  try {
    await action(code);
    const pid = Number(readFileSync(path, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    // Production cleanup must already have completed. The safety cleanup in
    // finally must never make this assertion pass after a production defect.
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    t.diagnostic(`Owned descendant PID ${pid}: production absence verified`);
  } catch (error) {
    failure = error;
  } finally {
    // Keep the PID record until this fixture's exact child is gone, including
    // when a behavior assertion fails before the ordinary absence check.
    try {
      await cleanupOwnedDescendant(t, dir, path);
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (failure && cleanupFailure)
    throw new AggregateError(
      [failure, cleanupFailure],
      "fixture and cleanup failed",
    );
  if (cleanupFailure) throw cleanupFailure;
  if (failure) throw failure;
}

test("exit-zero leader cannot leave a redirected descendant", async (t) => {
  await ownedDescendant(t, async (code) => {
    await assert.rejects(js(code), /lingering/);
  });
});

for (const persistent of [false, true])
  test(`post-kill EPERM ${persistent ? "retains debt" : "waits for ESRCH"}`, async (t) => {
    await ownedDescendant(t, async (code) => {
      const originalKill = process.kill.bind(process);
      let killedGroup,
        observations = 0;
      const mock = t.mock.method(process, "kill", (pid, signal) => {
        if (
          pid === killedGroup &&
          signal === 0 &&
          (persistent || observations < 3)
        ) {
          observations++;
          const error = new Error("synthetic permission denial");
          error.code = "EPERM";
          throw error;
        }
        const result = originalKill(pid, signal);
        if (pid < 0 && signal === "SIGKILL") killedGroup = pid;
        return result;
      });
      const start = performance.now();
      try {
        await assert.rejects(js(code, { cleanupMs: 100 }), (error) => {
          assert.equal(error.cleanupDebt, persistent);
          assert.equal(
            error.code,
            persistent
              ? "process cleanup incomplete"
              : "lingering command descendants",
          );
          return true;
        });
        assert.ok(observations >= 3, "EPERM was not observed repeatedly");
        assert.ok(performance.now() - start >= (persistent ? 100 : 20));
      } finally {
        mock.mock.restore();
      }
    });
  });
test("spawn error remains sanitized", async () => {
  await assert.rejects(
    runBounded("/missing/private-scanner-path", []),
    (error) =>
      !error.message.includes("private-scanner-path") &&
      /could not start/.test(error.message),
  );
});

test("invalid operation budgets refuse before acquisition or spawn", async () => {
  for (const cap of [0, -1, Infinity, 1.5]) {
    await assert.rejects(
      download(url, "0".repeat(64), {
        cap,
        fetchImpl: () => assert.fail("unexpected fetch"),
      }),
      /invalid operation limit/,
    );
    await assert.rejects(
      js("process.exit(0)", { cap }),
      /invalid operation limit/,
    );
  }
});
test("archive checksum and missing terminator refuse", () => {
  const header = Buffer.alloc(512);
  header.write("gitleaks");
  assert.throws(
    () =>
      executableFromArchive(
        gzipSync(Buffer.concat([header, Buffer.alloc(1024)])),
      ),
    /numeric|checksum/,
  );
  assert.throws(
    () => executableFromArchive(gzipSync(Buffer.alloc(512))),
    /terminator/,
  );
});
test("bounded extraction child writes only validated executable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scanner-extract-"));
  try {
    const archive = join(dir, "input.tgz"),
      executable = join(dir, "gitleaks");
    writeFileSync(
      archive,
      tar([
        ["LICENSE", Buffer.from("notice")],
        ["gitleaks", Buffer.from("binary")],
      ]),
    );
    const helper = new URL("./secret-scanner-runtime.mjs", import.meta.url);
    const result = await runBounded(
      process.execPath,
      [helper.pathname, "--extract", archive, executable],
      { timeoutMs: limits.extractionMs },
    );
    assert.equal(result.status, 0);
    assert.equal(readFileSync(executable, "utf8"), "binary");
    writeFileSync(archive, tar([["gitleaks"], ["link", Buffer.alloc(0), "2"]]));
    const refused = await runBounded(process.execPath, [
      helper.pathname,
      "--extract",
      archive,
      join(dir, "refused"),
    ]);
    assert.equal(refused.status, 1);
    assert.throws(() => readFileSync(join(dir, "refused")), { code: "ENOENT" });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("actual CLI SIGTERM during a stalled download closes its owned workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scanner-cli-"));
  try {
    await server(
      (req, res) => {
        res.writeHead(200);
        res.write("partial");
      },
      async (_fetchImpl, address) => {
        assert.ok(address);
        const entry = new URL("./check-secrets.mjs", import.meta.url).href;
        const code = `process.env.TMPDIR=${JSON.stringify(dir)};const original=fetch;globalThis.fetch=async (_url,options)=>{const response=await original(${JSON.stringify(address)},options);setTimeout(()=>process.kill(process.pid,'SIGTERM'),20);return response;};import(${JSON.stringify(entry)});`;
        const result = await js(code, { timeoutMs: 2000 });
        assert.equal(result.status, 143);
        assert.match(result.stderr.toString(), /Secret scanner: download/);
        assert.deepEqual(readdirSync(dir), []);
      },
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});
