import assert from "node:assert/strict";
import test from "node:test";
import { createMiniAppClient } from "@lo-ink/miniapp-sdk";
import {
  createWebAppAdapter,
  webAppCapabilities,
} from "../packages/compat/dist/index.js";

function client(webApp) {
  return createMiniAppClient(
    createWebAppAdapter(
      "external-webapp-fixture",
      { initData: "signed", ...webApp },
      webAppCapabilities(webApp),
    ),
  );
}

test("WebApp downloads preserve denial and reject malformed host results", async () => {
  let result = false;
  const received = [];
  const sdk = client({
    capabilities: ["downloadFile"],
    downloadFile(params, done) {
      received.push(params);
      done(result);
    },
  });
  const input = {
    url: "https://example.com/document.pdf",
    fileName: "document.pdf",
  };
  assert.equal(await sdk.call("downloadFile", input), false);
  assert.deepEqual(received, [{ url: input.url, file_name: input.fileName }]);
  result = true;
  assert.equal(await sdk.call("downloadFile", input), true);
  result = "accepted";
  await assert.rejects(sdk.call("downloadFile", input), {
    code: "invalid-response",
  });
  sdk.dispose();
});

test("WebApp frame commands preserve the host receiver and never change transport on failure", async () => {
  const calls = [];
  const host = {
    capabilities: [
      "ready",
      "close",
      "expand",
      "fullscreen",
      "hideKeyboard",
      "orientation",
      "verticalSwipes",
      "closingConfirmation",
      "headerColor",
      "backgroundColor",
      "bottomBarColor",
    ],
  };
  for (const name of [
    "ready",
    "close",
    "expand",
    "requestFullscreen",
    "exitFullscreen",
    "hideKeyboard",
    "lockOrientation",
    "unlockOrientation",
    "enableVerticalSwipes",
    "disableVerticalSwipes",
    "enableClosingConfirmation",
    "disableClosingConfirmation",
    "setHeaderColor",
    "setBackgroundColor",
    "setBottomBarColor",
  ]) {
    host[name] = function (...args) {
      assert.equal(this.initData, "signed");
      calls.push([name, ...args]);
    };
  }
  const sdk = client(host);
  for (const operation of [
    "ready",
    "close",
    "expand",
    "requestFullscreen",
    "exitFullscreen",
    "hideKeyboard",
  ])
    await sdk.call(operation);
  for (const [operation, field] of [
    ["setOrientationLock", "locked"],
    ["setVerticalSwipes", "enabled"],
    ["setClosingConfirmation", "enabled"],
  ]) {
    await sdk.call(operation, { [field]: true });
    await sdk.call(operation, { [field]: false });
  }
  for (const operation of [
    "setHeaderColor",
    "setBackgroundColor",
    "setBottomBarColor",
  ])
    await sdk.call(operation, { color: "#123456" });
  assert.equal(calls.length, 15);
  assert.deepEqual(calls.slice(-3), [
    ["setHeaderColor", "#123456"],
    ["setBackgroundColor", "#123456"],
    ["setBottomBarColor", "#123456"],
  ]);
  sdk.dispose();
});

test("back and settings buttons use their canonical visibility API and reject styling before mutation", async () => {
  const calls = [];
  const button = {
    show() {
      calls.push("show");
    },
    hide() {
      calls.push("hide");
    },
  };
  const sdk = client({
    capabilities: ["backButton", "settingsButton"],
    BackButton: button,
    SettingsButton: button,
  });
  for (const name of ["back", "settings"]) {
    await assert.rejects(
      sdk.call("setButton", {
        button: name,
        params: { visible: true, text: "Wrong" },
      }),
      { code: "unsupported" },
    );
    assert.deepEqual(calls, name === "back" ? [] : ["show", "hide"]);
    await sdk.call("setButton", { button: name, params: { visible: true } });
    await sdk.call("setButton", { button: name, params: { visible: false } });
  }
  assert.deepEqual(calls, ["show", "hide", "show", "hide"]);
  sdk.dispose();
});

test("biometry keeps consent refusal and authentication identity separate", async () => {
  const manager = {
    isInited: false,
    isBiometricAvailable: true,
    biometricType: "finger",
    deviceId: "device",
    init(done) {
      this.isInited = true;
      done();
    },
    requestAccess(params, done) {
      assert.equal(params.reason, "Sign in");
      done(false);
    },
    authenticate(_params, done) {
      done(false);
    },
    updateBiometricToken(_token, done) {
      done(true);
    },
    openSettings() {},
  };
  const sdk = client({ capabilities: ["biometry"], BiometricManager: manager });
  assert.deepEqual(await sdk.call("getBiometryInfo"), {
    available: true,
    type: "finger",
    accessRequested: false,
    accessGranted: false,
    tokenSaved: false,
    deviceId: "device",
  });
  assert.equal(
    await sdk.call("requestBiometryAccess", { reason: "Sign in" }),
    false,
  );
  assert.deepEqual(
    await sdk.call("authenticateBiometry", { reason: "Sign in" }),
    { authenticated: false },
  );
  assert.equal(
    await sdk.call("updateBiometryToken", { token: "fixture" }),
    true,
  );
  await sdk.call("openBiometrySettings");
  sdk.dispose();
});

test("storage absence and restored values stay distinct and malformed callbacks reject", async () => {
  const methods = {
    setItem(_key, _value, done) {
      done(null, true);
    },
    getItem(_key, done) {
      done(null, null, true);
    },
    restoreItem(_key, done) {
      done(null, "restored");
    },
    removeItem(_key, done) {
      done(null, true);
    },
    clear(done) {
      done(null, true);
    },
  };
  const sdk = client({
    capabilities: ["deviceStorage", "secureStorage", "cloudStorage"],
    DeviceStorage: methods,
    SecureStorage: methods,
    CloudStorage: {
      ...methods,
      getItem(_key, done) {
        done(null, "value");
      },
      getItems(_keys, done) {
        done(null, { one: "value" });
      },
      removeItems(_keys, done) {
        done(null, true);
      },
      getKeys(done) {
        done(null, ["one"]);
      },
    },
  });
  for (const kind of ["device", "secure"]) {
    assert.equal(
      await sdk.call(`${kind}StorageSet`, { key: "one", value: "value" }),
      true,
    );
    assert.equal(await sdk.call(`${kind}StorageRemove`, { key: "one" }), true);
    assert.equal(await sdk.call(`${kind}StorageClear`), true);
  }
  assert.equal(await sdk.call("deviceStorageGet", { key: "one" }), null);
  assert.deepEqual(await sdk.call("secureStorageGet", { key: "one" }), {
    value: null,
    canRestore: true,
  });
  assert.equal(
    await sdk.call("secureStorageRestore", { key: "one" }),
    "restored",
  );
  assert.equal(await sdk.call("cloudStorageGet", { key: "one" }), "value");
  assert.equal(
    await sdk.call("cloudStorageSet", { key: "one", value: "value" }),
    true,
  );
  assert.equal(await sdk.call("cloudStorageRemove", { key: "one" }), true);
  assert.equal(
    await sdk.call("cloudStorageRemoveMany", { keys: ["one"] }),
    true,
  );
  assert.deepEqual(await sdk.call("cloudStorageKeys"), ["one"]);
  methods.getItem = (_key, done) => done(null, null, "invalid-restore-flag");
  await assert.rejects(sdk.call("secureStorageGet", { key: "one" }), {
    code: "invalid-response",
  });
  methods.restoreItem = (_key, done) => done(null, null);
  await assert.rejects(sdk.call("secureStorageRestore", { key: "one" }), {
    code: "invalid-response",
  });
  sdk.dispose();
});

test("bottom-button progress is mapped explicitly and preserves requested inactive state", async () => {
  const calls = [];
  const button = {
    active: true,
    showProgress(leaveActive) {
      this.active = leaveActive;
      calls.push("progress");
    },
    hideProgress() {
      this.active = true;
      calls.push("hide-progress");
    },
    setParams(params) {
      if (params.is_active !== undefined) this.active = params.is_active;
      assert.equal(Object.hasOwn(params, "is_progress_visible"), false);
      calls.push("params");
    },
  };
  const sdk = client({
    capabilities: ["mainButton", "secondaryButton"],
    MainButton: button,
    SecondaryButton: button,
  });
  await sdk.call("setButton", {
    button: "main",
    params: { progressVisible: false, active: false },
  });
  assert.equal(button.active, false);
  assert.deepEqual(calls, ["hide-progress", "params"]);
  await sdk.call("setButton", {
    button: "secondary",
    params: { progressVisible: true, active: true, position: "left" },
  });
  assert.deepEqual(calls.slice(-2), ["progress", "params"]);
  const before = calls.length;
  await assert.rejects(
    sdk.call("setButton", { button: "main", params: { position: "left" } }),
    { code: "unsupported" },
  );
  assert.equal(calls.length, before);
  sdk.dispose();
  const partial = client({
    capabilities: ["mainButton"],
    MainButton: {
      setParams() {
        calls.push("partial");
      },
    },
  });
  await assert.rejects(
    partial.call("setButton", {
      button: "main",
      params: { text: "Open", progressVisible: true },
    }),
    { code: "unsupported" },
  );
  assert.equal(calls.length, before);
  partial.dispose();
});

test("WebApp haptics distinguish selection, impact and notification without fabricating arguments", async () => {
  const calls = [];
  const feedback = {
    selectionChanged(...args) {
      calls.push(["selection", ...args]);
    },
    impactOccurred(...args) {
      calls.push(["impact", ...args]);
    },
    notificationOccurred(...args) {
      calls.push(["notification", ...args]);
    },
  };
  const sdk = client({ capabilities: ["haptics"], HapticFeedback: feedback });
  await sdk.call("haptic", { kind: "selection" });
  await sdk.call("haptic", { kind: "light" });
  await sdk.call("haptic", { kind: "success" });
  assert.deepEqual(calls, [
    ["selection"],
    ["impact", "light"],
    ["notification", "success"],
  ]);
  delete feedback.selectionChanged;
  await assert.rejects(sdk.call("haptic", { kind: "selection" }), {
    code: "unsupported",
  });
  delete feedback.impactOccurred;
  await assert.rejects(sdk.call("haptic", { kind: "light" }), {
    code: "unsupported",
  });
  assert.equal(calls.length, 3);
  sdk.dispose();
});
