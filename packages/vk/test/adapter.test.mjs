import assert from "node:assert/strict";
import { test } from "node:test";
import officialBridge from "@vkontakte/vk-bridge";
import { createMiniAppClient, MiniAppError } from "@lo/miniapp-sdk";
import { createAdapter, detectAdapter } from "../dist/index.js";

function mockBridge({ embedded = true, config, send } = {}) {
  const listeners = new Set();
  const calls = [];
  const bridge = {
    calls,
    listeners,
    isEmbedded: () => embedded,
    subscribe: (listener) => listeners.add(listener),
    unsubscribe: (listener) => listeners.delete(listener),
    emit(type, data = {}) {
      for (const listener of [...listeners])
        listener({ detail: { type, data } });
    },
    async send(method, params) {
      calls.push({ method, params });
      if (send) return send(method, params);
      if (method === "VKWebAppInit") return { result: true };
      if (method === "VKWebAppGetConfig") {
        return (
          config ?? {
            app_id: "42",
            appearance: "dark",
            scheme: "vkcom_dark",
            viewport_width: 900,
            viewport_height: 640,
            api_host: "https://api.vk.ru",
          }
        );
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return bridge;
}

test("official bridge dependency conforms and detection is inert outside an embedded host", async () => {
  assert.equal(typeof officialBridge.send, "function");
  assert.equal(typeof officialBridge.subscribe, "function");
  assert.equal(typeof officialBridge.unsubscribe, "function");
  assert.equal(typeof officialBridge.isEmbedded, "function");
  assert.equal(
    await detectAdapter({ bridge: officialBridge, timeoutMs: 20 }),
    null,
  );
});

test("initializes with exact official calls and retains opaque launch data", async () => {
  const bridge = mockBridge();
  const launchData = "?vk_user_id=7&sign=opaque%2Bsignature";
  const adapter = await createAdapter({ bridge, launchData });
  assert.equal(adapter.id, "vk");
  assert.equal(adapter.launchData, launchData);
  assert.deepEqual([...adapter.capabilities], ["ready"]);
  assert.deepEqual(bridge.calls, [
    { method: "VKWebAppInit", params: undefined },
    { method: "VKWebAppGetConfig", params: undefined },
  ]);
  assert.deepEqual(adapter.snapshot(), {
    colorScheme: "dark",
    viewportHeight: 640,
  });

  const client = createMiniAppClient(adapter);
  await client.call("ready", undefined);
  await assert.rejects(
    client.call("openLink", { url: "https://example.com" }),
    (error) => {
      assert.ok(error instanceof MiniAppError);
      assert.equal(error.code, "unsupported");
      return true;
    },
  );
  assert.equal(client.supports("openLink"), false);
  assert.equal(client.supports("cloudStorage"), false);
});

test("normalizes config, inset, and view lifecycle events", async () => {
  const bridge = mockBridge({
    config: {
      app_id: "42",
      appearance: "light",
      scheme: "vkcom_light",
      app: "vkclient",
      insets: { top: 12, right: 1, bottom: 20, left: 2 },
    },
  });
  const adapter = await createAdapter({ bridge });
  assert.deepEqual(adapter.snapshot(), {
    colorScheme: "light",
    safeArea: { top: 12, right: 1, bottom: 20, left: 2 },
  });

  const events = [];
  const releases = [
    adapter.subscribe("themeChanged", (value) => events.push(["theme", value])),
    adapter.subscribe("viewportChanged", (value) =>
      events.push(["viewport", value]),
    ),
    adapter.subscribe("safeAreaChanged", (value) =>
      events.push(["safe", value]),
    ),
    adapter.subscribe("activated", () => events.push(["active"])),
    adapter.subscribe("deactivated", () => events.push(["inactive"])),
  ];
  bridge.emit("VKWebAppUpdateConfig", {
    app_id: "42",
    appearance: "dark",
    scheme: "space_gray",
    viewport_width: 800,
    viewport_height: 500,
    api_host: "https://api.vk.ru",
  });
  bridge.emit("VKWebAppUpdateInsets", {
    insets: { top: 4, right: 3, bottom: 2, left: 1 },
  });
  bridge.emit("VKWebAppViewHide");
  bridge.emit("VKWebAppViewRestore");

  assert.deepEqual(events, [
    [
      "theme",
      {
        colorScheme: "dark",
        viewportHeight: 500,
        safeArea: { top: 12, right: 1, bottom: 20, left: 2 },
      },
    ],
    [
      "viewport",
      {
        colorScheme: "dark",
        viewportHeight: 500,
        safeArea: { top: 12, right: 1, bottom: 20, left: 2 },
      },
    ],
    ["safe", { top: 4, right: 3, bottom: 2, left: 1 }],
    ["inactive"],
    ["active"],
  ]);
  assert.deepEqual(adapter.snapshot(), {
    colorScheme: "dark",
    viewportHeight: 500,
    safeArea: { top: 4, right: 3, bottom: 2, left: 1 },
  });
  for (const release of releases) release();
  for (const release of releases) release();
  assert.equal(bridge.listeners.size, 0);
});

test("ignores malformed host events and rejects unsupported subscriptions", async () => {
  const bridge = mockBridge();
  const adapter = await createAdapter({ bridge });
  const themes = [];
  const release = adapter.subscribe("themeChanged", (value) =>
    themes.push(value),
  );
  bridge.emit("VKWebAppUpdateConfig", { appearance: "dark" });
  bridge.emit("VKWebAppUpdateInsets", {
    insets: { top: -1, right: 0, bottom: 0, left: 0 },
  });
  assert.deepEqual(themes, []);
  assert.deepEqual(adapter.snapshot(), {
    colorScheme: "dark",
    viewportHeight: 640,
  });
  release();
  assert.throws(
    () => adapter.subscribe("backButtonClicked", () => {}),
    (error) => {
      assert.ok(error instanceof MiniAppError);
      assert.equal(error.code, "unsupported");
      return true;
    },
  );
});

test("bounds initialization with one timeout and an abort signal", async () => {
  const never = () => new Promise(() => {});
  await assert.rejects(
    createAdapter({ bridge: mockBridge({ send: never }), timeoutMs: 10 }),
    (error) => {
      assert.ok(error instanceof MiniAppError);
      assert.equal(error.code, "timeout");
      return true;
    },
  );

  const controller = new AbortController();
  const pending = createAdapter({
    bridge: mockBridge({ send: never }),
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof MiniAppError);
    assert.equal(error.code, "aborted");
    return true;
  });
});

test("does not start a host call after an immediate pre-start abort", async () => {
  const bridge = mockBridge();
  const controller = new AbortController();
  const pending = createAdapter({ bridge, signal: controller.signal });
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof MiniAppError && error.code === "aborted",
  );
  await Promise.resolve();
  assert.deepEqual(bridge.calls, []);
});

test("captures one validated signal for the full initialization", async () => {
  const bridge = mockBridge();
  const first = new AbortController();
  const second = new AbortController();
  second.abort();
  let reads = 0;
  const options = {
    bridge,
    get signal() {
      reads += 1;
      return reads === 1 ? first.signal : second.signal;
    },
  };
  await createAdapter(options);
  assert.equal(reads, 1);
  assert.equal(bridge.calls.length, 2);
});

test("rejects invalid or broken signals without leaving initialization pending", async () => {
  const bridge = mockBridge();
  await assert.rejects(
    createAdapter({ bridge, signal: { aborted: false } }),
    (error) =>
      error instanceof TypeError &&
      error.message === "signal must be an AbortSignal",
  );
  assert.deepEqual(bridge.calls, []);

  const registrationFailure = {
    aborted: false,
    addEventListener() {
      throw new Error("registration failed");
    },
    removeEventListener() {},
  };
  await assert.rejects(
    createAdapter({ bridge, signal: registrationFailure }),
    (error) => {
      assert.ok(error instanceof MiniAppError);
      assert.equal(error.code, "failed");
      return true;
    },
  );
  assert.deepEqual(bridge.calls, []);

  const releaseFailure = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {
      throw new Error("release failed");
    },
  };
  await createAdapter({ bridge, signal: releaseFailure });
  assert.equal(bridge.calls.length, 2);
});

test("released listeners stay inactive when host unsubscribe fails", async () => {
  const bridge = mockBridge();
  bridge.unsubscribe = () => {
    throw new Error("unsubscribe failed");
  };
  const adapter = await createAdapter({ bridge });
  let activations = 0;
  const release = adapter.subscribe("activated", () => {
    activations += 1;
  });
  release();
  bridge.emit("VKWebAppViewRestore");
  assert.equal(activations, 0);
});

test("validates host results and sanitizes bridge failures", async () => {
  await assert.rejects(
    createAdapter({
      bridge: mockBridge({ send: async () => ({ result: false }) }),
    }),
    (error) =>
      error instanceof MiniAppError && error.code === "invalid-response",
  );
  await assert.rejects(
    createAdapter({
      bridge: mockBridge({
        send: async () => {
          throw new Error("raw host failure");
        },
      }),
    }),
    (error) => {
      assert.ok(error instanceof MiniAppError);
      assert.equal(error.code, "failed");
      assert.equal(error.message.includes("raw host failure"), false);
      return true;
    },
  );
  await assert.rejects(
    createAdapter({ bridge: mockBridge(), timeoutMs: 0 }),
    RangeError,
  );
});
