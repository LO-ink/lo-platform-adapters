import test from "node:test";
import assert from "node:assert/strict";
import { createMiniAppClient } from "@lo/miniapp-sdk";
import { createAdapter as createLoAdapter } from "../packages/lo/dist/index.js";
import {
  createAdapter as createTelegramAdapter,
  isVersionAtLeast,
  loadAdapter,
} from "../packages/telegram/dist/index.js";

test("LO adapter requires launch data and trusts explicit capabilities", async () => {
  assert.equal(createLoAdapter({ LO: { WebApp: { initData: "" } } }), null);
  let callback;
  const adapter = createLoAdapter({
    LO: {
      WebApp: {
        initData: "signed",
        version: "99.0",
        capabilities: ["requestWriteAccess"],
        requestWriteAccess(done) {
          callback = done;
        },
      },
    },
  });
  assert.ok(adapter);
  assert.equal(adapter.id, "lo-legacy-webapp");
  assert.equal(adapter.capabilities.has("requestWriteAccess"), true);
  assert.equal(adapter.capabilities.has("fullscreen"), false);
  const client = createMiniAppClient(adapter);
  const pending = client.call("requestWriteAccess", undefined);
  callback(false);
  assert.equal(await pending, false);
});

test("Telegram adapter applies conservative version gates", () => {
  assert.equal(isVersionAtLeast("7.10", "7.9"), true);
  assert.equal(isVersionAtLeast("bad", "6.0"), false);
  const adapter = createTelegramAdapter({
    Telegram: { WebApp: { initData: "signed", version: "7.0" } },
  });
  assert.ok(adapter);
  assert.equal(adapter.capabilities.has("settingsButton"), true);
  assert.equal(adapter.capabilities.has("secondaryButton"), false);
  assert.equal(adapter.capabilities.has("shareMessage"), false);
  assert.equal(adapter.capabilities.has("invoice"), false);
});

test("invoice capability reflects the actual method and normalizes status", async () => {
  let finish;
  const telegram = createTelegramAdapter({
    Telegram: {
      WebApp: {
        initData: "signed",
        version: "8.0",
        openInvoice(_url, callback) {
          finish = callback;
        },
      },
    },
  });
  assert.equal(telegram.capabilities.has("invoice"), true);
  const client = createMiniAppClient(telegram);
  const payment = client.call("openInvoice", { url: "https://t.me/$invoice" });
  finish("paid");
  assert.equal(await payment, "paid");

  const lo = createLoAdapter({
    LO: {
      WebApp: {
        initData: "signed",
        capabilities: [],
        openInvoice() {
          throw new Error("must not run");
        },
      },
    },
  });
  await assert.rejects(
    createMiniAppClient(lo).call("openInvoice", {
      url: "https://t.me/$invoice",
    }),
    (error) => error.code === "unsupported",
  );
});

test("Telegram-only extensions stay outside the neutral operation map", async () => {
  let requestChatCallback;
  const adapter = createTelegramAdapter({
    Telegram: {
      WebApp: {
        initData: "signed",
        version: "9.6",
        requestChat(_id, callback) {
          requestChatCallback = callback;
        },
        setEmojiStatus(_id, _params, callback) {
          callback(true);
        },
        openTelegramLink() {},
      },
    },
  });
  const pending = adapter.telegram.requestChat("prepared-chat");
  requestChatCallback(false);
  assert.equal(await pending, false);
  assert.equal(await adapter.telegram.setEmojiStatus("123"), true);
  adapter.telegram.openTelegramLink("https://t.me/example");
});

test("adapter subscriptions release raw listeners exactly once", () => {
  let rawListener;
  let removals = 0;
  const adapter = createLoAdapter({
    LO: {
      WebApp: {
        initData: "signed",
        capabilities: [],
        onEvent(_name, listener) {
          rawListener = listener;
        },
        offEvent(_name, listener) {
          assert.equal(listener, rawListener);
          removals++;
        },
      },
    },
  });
  const client = createMiniAppClient(adapter);
  const off = client.on("activated", () => {});
  off();
  off();
  client.dispose();
  assert.equal(removals, 1);
});

test("missing raw event support is explicit", () => {
  const adapter = createLoAdapter({
    LO: { WebApp: { initData: "signed", capabilities: [] } },
  });
  assert.throws(
    () => createMiniAppClient(adapter).on("activated", () => {}),
    (error) => error.code === "unsupported",
  );
});

test("snapshot maps host theme keys into a semantic palette", () => {
  const adapter = createLoAdapter({
    LO: {
      WebApp: {
        initData: "signed",
        capabilities: [],
        themeParams: {
          bg_color: "#101010",
          text_color: "#fefefe",
          hint_color: "#888888",
          button_color: "#3366ff",
          secondary_bg_color: "#202020",
          unknown_color: "#ff00ff",
        },
      },
    },
  });
  assert.deepEqual(adapter.snapshot().theme, {
    background: "#101010",
    text: "#fefefe",
    mutedText: "#888888",
    action: "#3366ff",
    secondaryBackground: "#202020",
  });
  assert.equal("bg_color" in adapter.snapshot().theme, false);
});

test("sensor and fullscreen events normalize manager state instead of callback arguments", () => {
  const listeners = new Map();
  const webApp = {
    initData: "signed",
    capabilities: ["sensors", "fullscreen"],
    Accelerometer: { x: 1, y: 2, z: 3 },
    Gyroscope: { x: 4, y: 5, z: 6 },
    DeviceOrientation: { absolute: true, alpha: 7, beta: 8, gamma: 9 },
    onEvent(name, listener) {
      listeners.set(name, listener);
    },
    offEvent() {},
  };
  const client = createMiniAppClient(
    createLoAdapter({ LO: { WebApp: webApp } }),
  );
  const received = {};
  client.on("accelerometerChanged", (value) => {
    received.accelerometer = value;
  });
  client.on("gyroscopeChanged", (value) => {
    received.gyroscope = value;
  });
  client.on("orientationChanged", (value) => {
    received.orientation = value;
  });
  client.on("fullscreenFailed", (value) => {
    received.fullscreen = value;
  });
  listeners.get("accelerometerChanged")();
  listeners.get("gyroscopeChanged")();
  listeners.get("deviceOrientationChanged")();
  listeners.get("fullscreenFailed")({ error: "ALREADY_FULLSCREEN" });
  assert.deepEqual(received, {
    accelerometer: { x: 1, y: 2, z: 3 },
    gyroscope: { x: 4, y: 5, z: 6 },
    orientation: { absolute: true, alpha: 7, beta: 8, gamma: 9 },
    fullscreen: { reason: "ALREADY_FULLSCREEN" },
  });
});

test("disposing during location initialization does not open a native request", async () => {
  let finishInit;
  let locationRequests = 0;
  const adapter = createLoAdapter({
    LO: {
      WebApp: {
        initData: "signed",
        capabilities: ["location"],
        LocationManager: {
          isInited: false,
          init(callback) {
            finishInit = callback;
          },
          getLocation() {
            locationRequests++;
          },
        },
      },
    },
  });
  const client = createMiniAppClient(adapter);
  const pending = client.call("getLocation", undefined);
  client.dispose();
  finishInit();
  await assert.rejects(pending, (error) => error.code === "disposed");
  assert.equal(locationRequests, 0);
});

test("button fallback rejects unsupported styling before applying visibility", async () => {
  const calls = [];
  const adapter = createLoAdapter({
    LO: {
      WebApp: {
        initData: "signed",
        capabilities: ["mainButton"],
        MainButton: {
          setText(value) {
            calls.push(["text", value]);
          },
          enable() {
            calls.push(["enable"]);
          },
          show() {
            calls.push(["show"]);
          },
          hide() {
            calls.push(["hide"]);
          },
        },
      },
    },
  });
  const client = createMiniAppClient(adapter);
  await assert.rejects(
    client.call("setButton", {
      button: "main",
      params: { visible: true, color: "#ffffff" },
    }),
    (error) => error.code === "unsupported",
  );
  assert.deepEqual(calls, []);
  await client.call("setButton", {
    button: "main",
    params: { text: "Open", active: true, visible: true },
  });
  assert.deepEqual(calls, [["text", "Open"], ["enable"], ["show"]]);
});

test("storage rejection remains a failed host request", async () => {
  const adapter = createLoAdapter({
    LO: {
      WebApp: {
        initData: "signed",
        capabilities: ["deviceStorage"],
        DeviceStorage: {
          getItem(_key, done) {
            done(new Error("disk unavailable"));
          },
        },
      },
    },
  });
  const client = createMiniAppClient(adapter);
  await assert.rejects(
    client.call("deviceStorageGet", { key: "draft" }),
    (error) => error.code === "failed" && error.message === "disk unavailable",
  );
});

test("storage translation validates shapes and preserves own prototype-named keys", async () => {
  const record = { draft: "yes" };
  Object.defineProperty(record, "__proto__", {
    value: "safe",
    enumerable: true,
  });
  const adapter = createLoAdapter({
    LO: {
      WebApp: {
        initData: "signed",
        capabilities: ["cloudStorage", "deviceStorage"],
        CloudStorage: {
          getItems(_keys, done) {
            done(null, record);
          },
          getKeys(done) {
            done(null, ["draft", 1]);
          },
          setItem(_key, _value, done) {
            done(null, "false");
          },
        },
        DeviceStorage: {
          getItem(_key, done) {
            done(null, undefined);
          },
        },
      },
    },
  });
  const client = createMiniAppClient(adapter);
  const values = await client.call("cloudStorageGetMany", {
    keys: ["draft", "__proto__"],
  });
  assert.equal(Object.hasOwn(values, "__proto__"), true);
  assert.equal(values.__proto__, "safe");
  assert.equal(Object.getPrototypeOf(values), Object.prototype);
  await assert.rejects(
    client.call("cloudStorageKeys", undefined),
    (error) => error.code === "invalid-response",
  );
  await assert.rejects(
    client.call("cloudStorageSet", { key: "x", value: "y" }),
    (error) => error.code === "invalid-response",
  );
  await assert.rejects(
    client.call("deviceStorageGet", { key: "x" }),
    (error) => error.code === "invalid-response",
  );
});

test("Telegram loader is SSR-safe and removes failed script", async () => {
  assert.equal(await loadAdapter({ scope: {}, document: undefined }), null);
  let removed = 0;
  const script = {
    async: false,
    src: "",
    onload: null,
    onerror: null,
    remove() {
      removed++;
    },
  };
  const document = {
    createElement: () => script,
    head: {
      append() {
        queueMicrotask(() => script.onerror());
      },
    },
  };
  assert.equal(await loadAdapter({ scope: {}, document, timeoutMs: 50 }), null);
  assert.equal(removed, 1);
});
