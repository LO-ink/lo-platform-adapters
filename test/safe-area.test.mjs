import test from "node:test";
import assert from "node:assert/strict";
import { bindSafeAreaCss, createMiniAppClient } from "@lo-ink/miniapp-sdk";
import { createWebAppAdapter } from "../packages/compat/dist/index.js";

function absoluteInsetsAdapter(webApp) {
  return createWebAppAdapter("external-insets-fixture", webApp, new Set(), {
    contentSafeAreaIncludesSystem: true,
  });
}
import { createAdapter as createTelegramAdapter } from "../packages/telegram/dist/index.js";

const inset = (top, bottom = 0) => ({ top, right: 0, bottom, left: 0 });
function host() {
  const listeners = new Map();
  const webApp = {
    initData: "synthetic-launch",
    version: "8.0",
    safeAreaInset: inset(59, 34),
    contentSafeAreaInset: inset(111),
    onEvent(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    },
    offEvent(event, listener) {
      listeners.get(event)?.delete(listener);
      if (listeners.get(event)?.size === 0) listeners.delete(event);
    },
  };
  return {
    webApp,
    listeners,
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

test("Explicit WebApp translation converts full obstructions while real Telegram stays additive", () => {
  const { webApp } = host();
  const lo = absoluteInsetsAdapter(webApp);
  assert.equal(lo.snapshot().contentSafeArea.top, 52);
  assert.equal(lo.snapshot().contentSafeArea.bottom, 0);
  const alias = createTelegramAdapter({
    LO: { WebApp: webApp },
    Telegram: { WebApp: webApp },
  });
  assert.equal(alias.snapshot().contentSafeArea.top, 52);
  // Telegram Android supplies the system inset plus a separate 46px control row.
  webApp.contentSafeAreaInset = inset(46);
  const telegram = createTelegramAdapter({ Telegram: { WebApp: webApp } });
  assert.equal(telegram.snapshot().contentSafeArea.top, 46);
  const otherLoHost = createTelegramAdapter({
    LO: { WebApp: { ...webApp } },
    Telegram: { WebApp: webApp },
  });
  assert.equal(otherLoHost.snapshot().contentSafeArea.top, 46);
  assert.equal(lo.snapshot().contentSafeArea.top, 0);
  delete webApp.safeAreaInset;
  assert.equal(lo.snapshot().contentSafeArea.top, 46);
  delete webApp.contentSafeAreaInset;
  assert.equal(lo.snapshot().contentSafeArea, undefined);
});

for (const order of ["safe-first", "content-first"]) {
  test(`SDK CSS receives coherent translated insets with ${order} legacy events`, () => {
    const f = host();
    const values = new Map();
    const previous = globalThis.document;
    globalThis.document = {
      documentElement: {
        style: {
          getPropertyValue: (name) => values.get(name) ?? "",
          getPropertyPriority: () => "",
          setProperty: (name, value) => values.set(name, value),
          removeProperty: (name) => values.delete(name),
        },
      },
    };
    const client = createMiniAppClient(absoluteInsetsAdapter(f.webApp));
    try {
      const release = bindSafeAreaCss(client);
      assert.equal(values.get("--lo-safe-top"), "111px");
      assert.equal(values.get("--lo-safe-bottom"), "34px");
      const safe = () => {
        f.webApp.safeAreaInset = inset(47, 0);
        f.emit("safeAreaChanged");
      };
      const content = () => {
        f.webApp.contentSafeAreaInset = inset(99);
        f.emit("contentSafeAreaChanged");
      };
      if (order === "safe-first") {
        safe();
        assert.equal(values.get("--lo-safe-top"), "111px");
        content();
      } else {
        content();
        assert.equal(values.get("--lo-safe-top"), "99px");
        safe();
      }
      assert.equal(values.get("--lo-safe-top"), "99px");
      assert.equal(values.get("--lo-safe-bottom"), "0px");
      f.webApp.safeAreaInset = inset(0);
      f.webApp.contentSafeAreaInset = inset(0);
      f.emit("viewportChanged");
      assert.equal(values.get("--lo-safe-top"), "0px");
      const late = [...f.listeners.get("safeAreaChanged")];
      release();
      release();
      assert.equal(f.listeners.size, 0);
      for (const callback of late) callback();
      assert.equal(values.size, 0);
    } finally {
      client.dispose();
      globalThis.document = previous;
    }
  });
}

test("failed registration releases both legacy inset listeners", () => {
  const f = host();
  const onEvent = f.webApp.onEvent;
  f.webApp.onEvent = (event, listener) => {
    onEvent(event, listener);
    if (event === "safeAreaChanged") throw new Error("fixture rejection");
  };
  const adapter = absoluteInsetsAdapter(f.webApp);
  assert.throws(
    () => adapter.subscribe("contentSafeAreaChanged", () => {}),
    /fixture rejection/,
  );
  assert.equal(f.listeners.size, 0);
});

test("removal failures cannot skip another removal or revive inactive listeners", () => {
  for (const registrationFails of [false, true]) {
    const f = host();
    const onEvent = f.webApp.onEvent;
    const offEvent = f.webApp.offEvent;
    const attempts = [];
    let notifications = 0;
    f.webApp.onEvent = (event, listener) => {
      onEvent(event, listener);
      if (registrationFails && event === "safeAreaChanged")
        throw new Error("registration failed");
    };
    f.webApp.offEvent = (event, listener) => {
      attempts.push(event);
      if (event === "contentSafeAreaChanged") throw new Error("removal failed");
      offEvent(event, listener);
    };
    const adapter = absoluteInsetsAdapter(f.webApp);
    const subscribe = () =>
      adapter.subscribe("contentSafeAreaChanged", () => notifications++);
    if (registrationFails) {
      assert.throws(subscribe, /registration failed/);
    } else {
      const release = subscribe();
      assert.throws(release, /removal failed/);
      release();
    }
    assert.deepEqual(attempts, ["contentSafeAreaChanged", "safeAreaChanged"]);
    assert.equal(f.listeners.has("safeAreaChanged"), false);
    f.emit("contentSafeAreaChanged");
    assert.equal(notifications, 0);
  }
});
