import test from "node:test";
import assert from "node:assert/strict";
import { createMiniAppClient } from "@lo/miniapp-sdk";
import { createAdapter, createNativeAdapter } from "../dist/index.js";

const baseEnvelope = (generation, fields) => ({
  channel: "lo.miniapp",
  version: 1,
  generation,
  ...fields,
});

function nativePort(overrides = {}) {
  const listeners = new Set();
  const retained = [];
  const messages = [];
  let removals = 0;
  const port = {
    protocolVersion: 1,
    generation: "seed:document",
    launchData: "signed-launch",
    operations: [
      "ready",
      "expand",
      "setClosingConfirmation",
      "openLink",
      "sendData",
      "requestWriteAccess",
    ],
    capabilities: [
      "ready",
      "expand",
      "closingConfirmation",
      "openLink",
      "sendData",
      "requestWriteAccess",
    ],
    snapshot: () => ({
      colorScheme: "dark",
      theme: { background: "#101010" },
      viewportHeight: 640,
    }),
    postMessage(raw) {
      assert.ok(listeners.size > 0, "the adapter subscribes before sending");
      messages.push(JSON.parse(raw));
    },
    subscribe(listener) {
      listeners.add(listener);
      retained.push(listener);
      return () => {
        removals += 1;
        listeners.delete(listener);
      };
    },
    ...overrides,
  };
  return {
    port,
    messages,
    retained,
    listeners,
    removals: () => removals,
    emit(envelope) {
      const raw =
        typeof envelope === "string" ? envelope : JSON.stringify(envelope);
      for (const listener of [...listeners]) listener(raw);
    },
  };
}

function result(host, request, fields) {
  host.emit(
    baseEnvelope(host.port.generation, {
      kind: "result",
      id: request.id,
      ...fields,
    }),
  );
}

test("canonical discovery derives only implemented and jointly advertised capabilities", async () => {
  const host = nativePort({
    operations: ["ready", "expand", "futureOperation"],
    capabilities: ["ready", "openLink", "futureCapability"],
  });
  const adapter = createNativeAdapter({ LO: { MiniAppNative: host.port } });
  assert.ok(adapter);
  assert.equal(adapter.id, "lo");
  assert.equal(adapter.launchData, "signed-launch");
  assert.deepEqual([...adapter.capabilities], ["ready"]);
  assert.deepEqual([...adapter.nativeOperations], ["ready"]);
  assert.deepEqual(adapter.snapshot(), {
    colorScheme: "dark",
    theme: { background: "#101010" },
    viewportHeight: 640,
  });

  const client = createMiniAppClient(adapter);
  const pending = client.call("ready", undefined);
  assert.equal(host.messages.length, 1);
  const request = host.messages[0];
  assert.deepEqual(request, {
    channel: "lo.miniapp",
    version: 1,
    generation: "seed:document",
    kind: "request",
    id: request.id,
    operation: "ready",
  });
  assert.match(request.id, /^[A-Za-z0-9_-]{1,64}$/);
  result(host, request, { ok: true, value: null });
  assert.equal(await pending, undefined);
  assert.equal(host.removals(), 1);
});

test("write-access results are strict booleans and host errors are mapped", async () => {
  const host = nativePort();
  const adapter = createNativeAdapter({ LO: { MiniAppNative: host.port } });
  const client = createMiniAppClient(adapter);

  const denied = client.call("requestWriteAccess", undefined);
  result(host, host.messages.at(-1), { ok: true, value: false });
  assert.equal(await denied, false);

  const malformed = client.call("requestWriteAccess", undefined);
  result(host, host.messages.at(-1), { ok: true, value: "false" });
  await assert.rejects(malformed, { code: "invalid-response" });

  const unsupported = client.call("ready", undefined);
  result(host, host.messages.at(-1), {
    ok: false,
    error: { code: "unsupported_operation", message: "not available" },
  });
  await assert.rejects(unsupported, {
    code: "unsupported",
    message: "not available",
  });

  for (const [hostCode, sdkCode] of [
    ["invalid_request", "failed"],
    ["busy", "failed"],
    ["timeout", "timeout"],
    ["host_error", "failed"],
  ]) {
    const failed = client.call("ready", undefined);
    result(host, host.messages.at(-1), {
      ok: false,
      error: { code: hostCode, message: `${hostCode} fixture` },
    });
    await assert.rejects(failed, {
      code: sdkCode,
      message: `${hostCode} fixture`,
    });
  }

  const invalidError = client.call("ready", undefined);
  result(host, host.messages.at(-1), {
    ok: false,
    error: { code: "unknown", message: "bad" },
  });
  await assert.rejects(invalidError, { code: "invalid-response" });
});

test("matching legacy sessions compose fallback operations and live appearance", async () => {
  const host = nativePort({
    operations: ["ready", "openLink"],
    capabilities: ["ready", "openLink"],
    snapshot: () => ({ colorScheme: "dark", theme: { background: "#000000" } }),
  });
  const legacyListeners = new Map();
  let legacyReady = 0;
  let legacyExpand = 0;
  const legacy = {
    initData: "signed-launch",
    capabilities: ["ready", "expand", "openLink"],
    colorScheme: "light",
    themeParams: { bg_color: "#ffffff" },
    ready() {
      legacyReady += 1;
    },
    expand() {
      legacyExpand += 1;
    },
    openLink() {
      throw new Error("native operations must not fall back after selection");
    },
    onEvent(name, listener) {
      legacyListeners.set(name, listener);
    },
    offEvent(name) {
      legacyListeners.delete(name);
    },
  };
  const adapter = createAdapter({
    LO: { MiniAppNative: host.port, WebApp: legacy },
  });
  assert.equal(adapter.id, "lo");
  assert.deepEqual([...adapter.capabilities].sort(), [
    "expand",
    "openLink",
    "ready",
  ]);
  assert.deepEqual(adapter.snapshot(), {
    colorScheme: "light",
    theme: { background: "#ffffff" },
    viewportHeight: undefined,
    stableViewportHeight: undefined,
    safeArea: undefined,
    contentSafeArea: undefined,
    isFullscreen: undefined,
    isOrientationLocked: undefined,
  });

  const client = createMiniAppClient(adapter);
  assert.equal(await client.call("expand", undefined), undefined);
  assert.equal(legacyExpand, 1);

  const failed = client.call("openLink", { url: "https://example.com" });
  const request = host.messages.at(-1);
  result(host, request, {
    ok: false,
    error: { code: "host_error", message: "native failed" },
  });
  await assert.rejects(failed, { code: "failed", message: "native failed" });
  assert.equal(legacyReady, 0);

  let activated = 0;
  let themes = 0;
  const offActivated = client.on("activated", () => {
    activated += 1;
  });
  const offTheme = client.on("themeChanged", () => {
    themes += 1;
  });
  host.emit(
    baseEnvelope(host.port.generation, {
      kind: "event",
      event: "activated",
      payload: null,
    }),
  );
  legacyListeners.get("themeChanged")();
  assert.equal(activated, 1);
  assert.equal(themes, 1);
  offActivated();
  offTheme();
});

test("different launch sessions never compose and legacy-only identity is preserved", () => {
  const host = nativePort();
  const mismatched = createAdapter({
    LO: {
      MiniAppNative: host.port,
      WebApp: { initData: "different", capabilities: ["location"] },
    },
  });
  assert.equal(mismatched.id, "lo");
  assert.equal(mismatched.capabilities.has("location"), false);

  const legacyOnly = createAdapter({
    LO: { WebApp: { initData: "legacy", capabilities: [] } },
  });
  assert.equal(legacyOnly.id, "lo-legacy-webapp");
});

test("abort sends one cancel for a pending request and retained callbacks stay inactive", async () => {
  const host = nativePort();
  const client = createMiniAppClient(
    createNativeAdapter({ LO: { MiniAppNative: host.port } }),
  );
  const controller = new AbortController();
  const pending = client.call("ready", undefined, {
    signal: controller.signal,
  });
  const request = host.messages[0];
  controller.abort();
  await assert.rejects(pending, { code: "aborted" });
  assert.deepEqual(host.messages[1], {
    channel: "lo.miniapp",
    version: 1,
    generation: "seed:document",
    kind: "cancel",
    id: request.id,
  });
  assert.equal(host.removals(), 1);
  result(host, request, { ok: true, value: null });
  assert.equal(host.messages.length, 2);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const direct = client.adapter.execute("ready", undefined, {
    signal: alreadyAborted.signal,
  });
  await assert.rejects("promise" in direct ? direct.promise : direct, {
    code: "aborted",
  });
  assert.equal(host.messages.length, 2);
});

test("malformed, foreign and late lifecycle envelopes do not reach listeners", () => {
  let releaseCalls = 0;
  const host = nativePort({
    subscribe(listener) {
      host.retained.push(listener);
      host.listeners.add(listener);
      return () => {
        releaseCalls += 1;
        throw new Error("host release failure");
      };
    },
  });
  const adapter = createNativeAdapter({ LO: { MiniAppNative: host.port } });
  let activations = 0;
  let secondListener = 0;
  const off = adapter.subscribe("activated", () => {
    activations += 1;
    throw new Error("listener failure");
  });
  const offSecond = adapter.subscribe("activated", () => {
    secondListener += 1;
  });
  host.emit("not json");
  host.emit(
    baseEnvelope("another:generation", {
      kind: "event",
      event: "activated",
      payload: null,
    }),
  );
  host.emit(
    baseEnvelope(host.port.generation, {
      kind: "event",
      event: "activated",
      payload: {},
    }),
  );
  host.emit(
    baseEnvelope(host.port.generation, {
      kind: "event",
      event: "activated",
      payload: null,
    }),
  );
  assert.equal(activations, 1);
  assert.equal(secondListener, 1);
  off();
  off();
  offSecond();
  assert.equal(releaseCalls, 1);
  for (const listener of host.retained) {
    listener(
      JSON.stringify(
        baseEnvelope(host.port.generation, {
          kind: "event",
          event: "activated",
          payload: null,
        }),
      ),
    );
  }
  assert.equal(activations, 1);
  assert.equal(secondListener, 1);
  assert.throws(() => adapter.subscribe("themeChanged", () => {}), {
    code: "unsupported",
  });
});

test("request setup and encoding failures settle without sending or retaining callbacks", async () => {
  const subscriptionFailure = nativePort({
    subscribe() {
      throw new Error("subscribe failed");
    },
  });
  const first = createMiniAppClient(
    createNativeAdapter({ LO: { MiniAppNative: subscriptionFailure.port } }),
  );
  await assert.rejects(first.call("ready", undefined), {
    code: "failed",
    message: "subscribe failed",
  });
  assert.equal(subscriptionFailure.messages.length, 0);

  const postFailure = nativePort({
    postMessage() {
      throw new Error("post failed");
    },
  });
  const second = createMiniAppClient(
    createNativeAdapter({ LO: { MiniAppNative: postFailure.port } }),
  );
  await assert.rejects(second.call("ready", undefined), {
    code: "failed",
    message: "post failed",
  });
  assert.equal(postFailure.removals(), 1);

  const cyclicHost = nativePort();
  const cyclicAdapter = createNativeAdapter({
    LO: { MiniAppNative: cyclicHost.port },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  const direct = cyclicAdapter.execute("openLink", cyclic, {});
  await assert.rejects("promise" in direct ? direct.promise : direct, {
    code: "failed",
  });
  assert.equal(cyclicHost.messages.length, 0);
  assert.equal(cyclicHost.removals(), 1);
});

test("pending limit and request IDs are shared across adapters for one port", async () => {
  const host = nativePort();
  const first = createNativeAdapter({ LO: { MiniAppNative: host.port } });
  const second = createNativeAdapter({ LO: { MiniAppNative: host.port } });
  const offActivated = first.subscribe("activated", () => {});
  const requests = [];
  for (let index = 0; index < 32; index += 1) {
    const adapter = index % 2 === 0 ? first : second;
    requests.push(adapter.execute("ready", undefined, {}));
  }
  assert.equal(host.messages.length, 32);
  assert.equal(host.listeners.size, 1);
  assert.equal(new Set(host.messages.map((entry) => entry.id)).size, 32);
  const overflow = first.execute("ready", undefined, {});
  await assert.rejects("promise" in overflow ? overflow.promise : overflow, {
    code: "failed",
    message: "LO host has too many pending requests",
  });
  for (const entry of requests) entry.cleanup();
  const settled = await Promise.allSettled(
    requests.map((entry) => entry.promise),
  );
  assert.equal(
    settled.every((entry) => entry.status === "rejected"),
    true,
  );
  offActivated();
  assert.equal(host.listeners.size, 0);
  assert.equal(host.removals(), 1);
});

test("invalid ports fall back safely and later invalid snapshots preserve the last valid value", () => {
  for (const override of [
    { protocolVersion: 2 },
    { generation: "" },
    { generation: "short" },
    { generation: "x".repeat(129) },
    { generation: "invalid/generation" },
    { generation: `valid${String.fromCharCode(0xd800)}` },
    { generation: `valid${String.fromCharCode(0xdc00)}` },
    { launchData: "" },
    { launchData: `signed${String.fromCharCode(0xd800)}` },
    { launchData: `signed${String.fromCharCode(0xdc00)}` },
    { operations: ["ready", "ready"] },
    { capabilities: ["ready", 1] },
    { snapshot: () => ({ colorScheme: "blue" }) },
  ]) {
    const host = nativePort(override);
    assert.equal(
      createNativeAdapter({ LO: { MiniAppNative: host.port } }),
      null,
    );
  }

  let snapshot = { colorScheme: "light", viewportHeight: 500 };
  const host = nativePort({ snapshot: () => snapshot });
  const adapter = createNativeAdapter({ LO: { MiniAppNative: host.port } });
  assert.deepEqual(adapter.snapshot(), snapshot);
  snapshot = { colorScheme: "invalid" };
  assert.deepEqual(adapter.snapshot(), {
    colorScheme: "light",
    viewportHeight: 500,
  });
});
