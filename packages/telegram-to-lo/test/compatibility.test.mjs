import test from "node:test";
import assert from "node:assert/strict";
import { installTelegramCompatibility } from "../dist/index.js";

const webApp = (overrides = {}) => ({
  initData: "lo-signed-bytes",
  capabilities: ["ready"],
  ...overrides,
});

test("SSR and unavailable hosts remain inert", () => {
  assert.equal(installTelegramCompatibility(), null);
  for (const scope of [
    {},
    { LO: { WebApp: {} } },
    { LO: { WebApp: webApp({ initData: "" }) } },
    { LO: { WebApp: webApp({ capabilities: [1] }) } },
  ]) {
    assert.equal(installTelegramCompatibility(scope), null);
    assert.equal(Object.hasOwn(scope, "Telegram"), false);
  }
  assert.equal(
    installTelegramCompatibility({
      get LO() {
        throw new Error("unavailable");
      },
    }),
    null,
  );
});

test("bridge preserves signed bytes, native receiver, events, denial, and capability limits", () => {
  const listeners = new Set();
  const source = webApp({
    onEvent(event, listener) {
      assert.equal(this, source);
      listeners.add(listener);
    },
    offEvent(event, listener) {
      assert.equal(this, source);
      listeners.delete(listener);
    },
    requestWriteAccess(callback) {
      assert.equal(this, source);
      callback(false);
    },
  });
  const scope = { LO: { WebApp: source } };
  const lease = installTelegramCompatibility(scope);
  assert.equal(lease.installed, true);
  assert.equal(scope.Telegram.WebApp, source);
  assert.equal(scope.Telegram.WebApp.initData, "lo-signed-bytes");
  let clicks = 0;
  const listener = () => clicks++;
  scope.Telegram.WebApp.onEvent("mainButtonClicked", listener);
  for (const callback of listeners) callback();
  scope.Telegram.WebApp.offEvent("mainButtonClicked", listener);
  scope.Telegram.WebApp.requestWriteAccess((allowed) =>
    assert.equal(allowed, false),
  );
  assert.equal(clicks, 1);
  assert.equal(listeners.size, 0);
  assert.equal(scope.Telegram.WebApp.openInvoice, undefined);
  assert.equal(scope.Telegram.WebApp.version, undefined);
  lease.dispose();
  lease.dispose();
  assert.equal(lease.installed, false);
  assert.equal(Object.hasOwn(scope, "Telegram"), false);
});

test("multiple owners release the bridge only after the final lease", () => {
  const scope = { LO: { WebApp: webApp() } };
  const first = installTelegramCompatibility(scope);
  const second = installTelegramCompatibility(scope);
  first.dispose();
  assert.equal(first.installed, false);
  assert.equal(second.installed, true);
  second.dispose();
  assert.equal(Object.hasOwn(scope, "Telegram"), false);
});

test("existing globals and non-configurable properties are never overwritten", () => {
  for (const Telegram of [
    { WebApp: {} },
    { WebApp: webApp() },
    null,
    "invalid",
  ]) {
    const scope = { LO: { WebApp: webApp() }, Telegram };
    assert.throws(() => installTelegramCompatibility(scope));
    assert.equal(scope.Telegram, Telegram);
  }
  const scope = Object.freeze({ LO: { WebApp: webApp() } });
  assert.throws(() => installTelegramCompatibility(scope), TypeError);
  const fixed = { LO: { WebApp: webApp() }, Telegram: {} };
  Object.defineProperty(fixed.Telegram, "WebApp", { value: undefined });
  assert.throws(() => installTelegramCompatibility(fixed), TypeError);
  assert.equal(fixed.Telegram.WebApp, undefined);
});

test("existing namespace and exact property descriptor are restored", () => {
  const container = { extra: 42 };
  const descriptor = {
    value: undefined,
    enumerable: false,
    configurable: true,
    writable: false,
  };
  Object.defineProperty(container, "WebApp", descriptor);
  const scope = { LO: { WebApp: webApp() }, Telegram: container };
  const lease = installTelegramCompatibility(scope);
  assert.equal(scope.Telegram.extra, 42);
  lease.dispose();
  assert.equal(scope.Telegram, container);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(container, "WebApp"),
    descriptor,
  );
});

test("cleanup preserves a namespace or WebApp installed by another owner", () => {
  for (const change of [
    (scope) => {
      scope.Telegram = { WebApp: { replacement: true } };
    },
    (scope) => {
      scope.Telegram.WebApp = { replacement: true };
    },
  ]) {
    const scope = { LO: { WebApp: webApp() } };
    const lease = installTelegramCompatibility(scope);
    change(scope);
    assert.equal(lease.installed, false);
    assert.throws(() => installTelegramCompatibility(scope));
    lease.dispose();
    assert.equal(scope.Telegram.WebApp.replacement, true);
  }
});

test("a changed LO session cannot acquire a second lease", () => {
  const scope = { LO: { WebApp: webApp() } };
  const lease = installTelegramCompatibility(scope);
  scope.LO.WebApp = webApp({ initData: "new-session" });
  assert.throws(() => installTelegramCompatibility(scope));
  lease.dispose();
  const next = installTelegramCompatibility(scope);
  assert.equal(scope.Telegram.WebApp.initData, "new-session");
  next.dispose();
});

test("namespace additions by another integration survive disposal", () => {
  const scope = { LO: { WebApp: webApp() } };
  const lease = installTelegramCompatibility(scope);
  scope.Telegram.otherIntegration = 42;
  lease.dispose();
  assert.deepEqual(scope.Telegram, { otherIntegration: 42 });
});

test("mutating launch data in place invalidates an active lease", () => {
  const scope = { LO: { WebApp: webApp() } };
  const lease = installTelegramCompatibility(scope);
  scope.LO.WebApp.initData = "another-session";
  assert.equal(lease.installed, false);
  assert.throws(() => installTelegramCompatibility(scope));
  lease.dispose();
  assert.equal(Object.hasOwn(scope, "Telegram"), false);
});

test("same-value getters installed by another owner survive disposal", () => {
  for (const existingNamespace of [false, true]) {
    for (const property of ["Telegram", "WebApp"]) {
      const source = webApp();
      const scope = { LO: { WebApp: source } };
      if (existingNamespace) scope.Telegram = {};
      const lease = installTelegramCompatibility(scope);
      const container = scope.Telegram;
      const target = property === "Telegram" ? scope : container;
      const replacement = {
        get: () => (property === "Telegram" ? container : source),
        configurable: true,
        enumerable: false,
      };
      Object.defineProperty(target, property, replacement);
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      if (property === "WebApp" || !existingNamespace) {
        assert.equal(lease.installed, false);
        assert.throws(() => installTelegramCompatibility(scope));
      }
      lease.dispose();
      assert.deepEqual(
        Object.getOwnPropertyDescriptor(target, property),
        descriptor,
      );
    }
  }
});

test("same-value descriptor flag changes invalidate ownership without being restored", () => {
  const scope = { LO: { WebApp: webApp() } };
  const lease = installTelegramCompatibility(scope);
  Object.defineProperty(scope.Telegram, "WebApp", { writable: false });
  const replacement = Object.getOwnPropertyDescriptor(scope.Telegram, "WebApp");
  assert.equal(lease.installed, false);
  assert.throws(() => installTelegramCompatibility(scope));
  lease.dispose();
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(scope.Telegram, "WebApp"),
    replacement,
  );
});
