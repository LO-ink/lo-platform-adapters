import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as settle } from "node:timers/promises";
import ts from "typescript";

function events() {
  const handlers = new Map();
  return {
    handlers,
    addEventListener(name, handler) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(handler);
    },
    removeEventListener(name, handler) {
      handlers.get(name)?.delete(handler);
    },
    fire(name, event = {}) {
      return Promise.all(
        [...(handlers.get(name) ?? [])].map((handler) => handler(event)),
      );
    },
    count(name) {
      return handlers.get(name)?.size ?? 0;
    },
  };
}

function fixture(t, host = "lo-native") {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "lo-example-consumer-"));
  const lifecycle = events(),
    button = events(),
    media = events();
  const element = {
    dataset: { miniappHost: host },
    style: { setProperty() {} },
  };
  const globals = {
    LO: undefined,
    Telegram: undefined,
    document: {
      documentElement: element,
      querySelector: () => button,
      createElement() {
        throw new Error("A native example must not load a foreign script");
      },
    },
    matchMedia: () => ({ matches: false, ...media }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    addEventListener: lifecycle.addEventListener,
    removeEventListener: lifecycle.removeEventListener,
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  symlinkSync(
    process.env.LO_NATIVE_EXAMPLE_MODULES ?? join(root, "node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  for (const name of ["lifecycle", "vanilla", "cross-platform"]) {
    const source = readFileSync(join(root, "examples", name + ".ts"), "utf8");
    writeFileSync(
      join(directory, name + ".js"),
      ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
    );
  }
  t.after(async () => {
    await lifecycle.fire("pagehide", { persisted: false });
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    lifecycle,
    button,
    media,
    element,
    load: (name) => import(pathToFileURL(join(directory, name + ".js")).href),
  };
}

function nativePort(
  generation,
  capabilities = ["ready", "expand", "requestWriteAccess"],
) {
  generation = `example:${generation}`;
  const listeners = new Set(),
    calls = [];
  const held = new Set();
  const firstCall = Promise.withResolvers();
  const port = {
    protocolVersion: 1,
    generation,
    launchData: "synthetic-signed-launch",
    operations: capabilities,
    capabilities,
    events: ["activated", "deactivated", "themeChanged"],
    snapshot: () => ({ colorScheme: "dark" }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    postMessage(raw) {
      const request = JSON.parse(raw);
      if (request.kind === "cancel") return;
      calls.push(request);
      firstCall.resolve(request);
      if (
        request.operation !== "requestWriteAccess" &&
        !held.has(request.operation)
      )
        answer(request, null);
    },
  };
  function answer(request, value) {
    for (const listener of [...listeners])
      listener(
        JSON.stringify({
          channel: "lo.miniapp",
          version: 1,
          generation,
          kind: "result",
          id: request.id,
          ok: true,
          value,
        }),
      );
  }
  return { port, listeners, calls, answer, held, firstCall: firstCall.promise };
}

for (const [example, host] of [
  ["vanilla", "lo-native"],
  ["cross-platform", "lo-native"],
  ["cross-platform", "lo-legacy"],
]) {
  test(`${example}/${host} starts on a partial host without another provider`, async (t) => {
    const f = fixture(t, host),
      native = nativePort("partial", ["ready"]);
    let legacyReady = 0;
    globalThis.LO =
      host === "lo-native"
        ? { MiniAppNative: native.port }
        : {
            WebApp: {
              initData: "synthetic-signed-launch",
              capabilities: ["ready"],
              ready() {
                legacyReady++;
              },
            },
          };
    await f.load(example);
    assert.equal(host === "lo-native" ? native.calls.length : legacyReady, 1);
    assert.equal(f.element.dataset.miniappState, "ready");
    assert.equal(f.button.count("click"), 1);
    await f.lifecycle.fire("pagehide", { persisted: false });
    assert.equal(native.listeners.size, 0);
    assert.equal(f.media.count("change"), 0);
    assert.equal(f.button.count("click"), 0);
    assert.equal(f.lifecycle.count("pageshow"), 0);
  });
}

for (const example of ["vanilla", "cross-platform"]) {
  test(`${example} recreates the current native session on repeated cached restores without replaying permissions`, async (t) => {
    const f = fixture(t),
      first = nativePort("first");
    globalThis.LO = { MiniAppNative: first.port };
    await f.load(example);
    const subscriptions = first.listeners.size;
    assert.ok(subscriptions > 0);
    assert.equal(f.media.count("change"), 1);
    const oldPermission = f.button.fire("click");
    await settle();
    const pending = first.calls.find(
      (call) => call.operation === "requestWriteAccess",
    );
    assert.ok(pending);
    await f.button.fire("click");
    assert.equal(
      first.calls.filter((call) => call.operation === "requestWriteAccess")
        .length,
      1,
    );
    await f.lifecycle.fire("pagehide", { persisted: true });
    await oldPermission;
    assert.equal(first.listeners.size, 0);
    assert.equal(f.media.count("change"), 0);
    first.answer(pending, true);
    assert.equal(f.element.dataset.writeAccess, undefined);
    await f.button.fire("click");
    assert.equal(first.calls.length, 3);

    for (let index = 0; index < 2; index++) {
      const current = nativePort(`restored-${index}`);
      globalThis.LO = { MiniAppNative: current.port };
      await f.lifecycle.fire("pageshow", { persisted: true });
      await settle();
      assert.equal(f.element.dataset.miniappState, "ready");
      assert.deepEqual(
        current.calls.map((call) => call.operation),
        ["ready"],
      );
      assert.equal(current.listeners.size, subscriptions);
      assert.equal(f.media.count("change"), 1);
      assert.equal(f.button.count("click"), 1);
      await f.lifecycle.fire("pageshow", { persisted: true });
      await settle();
      assert.equal(current.calls.length, 1);
      const permission = f.button.fire("click");
      await settle();
      current.answer(current.calls.at(-1), true);
      await permission;
      assert.equal(f.element.dataset.writeAccess, "allowed");
      await f.lifecycle.fire("pagehide", { persisted: index === 0 });
      assert.equal(current.listeners.size, 0);
      assert.equal(f.media.count("change"), 0);
      assert.equal(f.element.dataset.writeAccess, undefined);
    }
    assert.equal(f.button.count("click"), 0);
    assert.equal(f.lifecycle.count("pagehide"), 0);
    assert.equal(f.lifecycle.count("pageshow"), 0);
  });
}

test("teardown during native readiness stops later setup and removes every handler", async (t) => {
  const f = fixture(t),
    native = nativePort("pending-ready");
  native.held.add("ready");
  globalThis.LO = { MiniAppNative: native.port };
  const loading = f.load("vanilla");
  const request = await native.firstCall;
  assert.equal(request.operation, "ready");
  await f.lifecycle.fire("pagehide", { persisted: false });
  await loading;
  native.answer(request, null);
  await settle();
  assert.deepEqual(
    native.calls.map((call) => call.operation),
    ["ready"],
  );
  assert.equal(native.listeners.size, 0);
  assert.equal(f.media.count("change"), 0);
  assert.equal(f.button.count("click"), 0);
  assert.equal(f.lifecycle.count("pageshow"), 0);
  assert.equal(f.element.dataset.miniappState, "suspended");
});

test("a delayed external provider cannot bind or call a stale session after hide/restore", async (t) => {
  const f = fixture(t, "telegram");
  let appended;
  const scriptAdded = new Promise((resolve) => {
    appended = resolve;
  });
  const script = { remove() {} };
  globalThis.document.createElement = () => script;
  globalThis.document.head = {
    append() {
      appended();
    },
  };
  const initial = f.load("cross-platform");
  await scriptAdded;
  await f.lifecycle.fire("pagehide", { persisted: true });
  f.element.dataset.miniappHost = "lo-native";
  const current = nativePort("new-native");
  globalThis.LO = { MiniAppNative: current.port };
  await f.lifecycle.fire("pageshow", { persisted: true });
  await settle();
  let oldReady = 0;
  const oldEvents = new Set();
  globalThis.Telegram = {
    WebApp: {
      initData: "synthetic-external-launch",
      version: "6.0",
      colorScheme: "light",
      ready() {
        oldReady++;
      },
      expand() {
        oldReady++;
      },
      onEvent(_name, handler) {
        oldEvents.add(handler);
      },
      offEvent(_name, handler) {
        oldEvents.delete(handler);
      },
    },
  };
  script.onload();
  await initial;
  assert.equal(oldReady, 0);
  assert.equal(oldEvents.size, 0);
  assert.deepEqual(
    current.calls.map((call) => call.operation),
    ["ready"],
  );
  assert.equal(f.element.dataset.loTheme, "dark");
  assert.equal(f.element.dataset.miniappState, "ready");
  assert.equal(f.media.count("change"), 1);
  assert.equal(f.button.count("click"), 1);
});
