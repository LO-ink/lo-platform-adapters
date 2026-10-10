import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  installTelegramCompatibility as install,
  COMPATIBILITY_LIMITS,
} from "../dist/index.js";
import { MINI_APP_CAPABILITIES } from "@lo-ink/miniapp-sdk";
const owned = new Set();
const installTelegramCompatibility = (...args) => {
  const result = install(...args);
  if (result) owned.add(result);
  return result;
};
afterEach(async () => {
  for (const lease of owned) await lease.dispose();
  owned.clear();
});
const operations = [
  "ready",
  "close",
  "expand",
  "requestFullscreen",
  "exitFullscreen",
  "hideKeyboard",
  "setOrientationLock",
  "setButton",
  "setClosingConfirmation",
  "setVerticalSwipes",
  "setHeaderColor",
  "setBackgroundColor",
  "setBottomBarColor",
  "haptic",
  "showPopup",
  "openLink",
  "sendData",
  "switchInlineQuery",
  "readClipboard",
  "downloadFile",
  "requestWriteAccess",
  "requestContact",
  "shareMessage",
  "shareToStory",
  "openInvoice",
  "cloudStorageSet",
  "cloudStorageGet",
  "cloudStorageGetMany",
  "cloudStorageRemove",
  "cloudStorageRemoveMany",
  "cloudStorageKeys",
  "deviceStorageSet",
  "deviceStorageGet",
  "deviceStorageRemove",
  "deviceStorageClear",
  "secureStorageSet",
  "secureStorageGet",
  "secureStorageRestore",
  "secureStorageRemove",
  "secureStorageClear",
];
const events = [
  "activated",
  "deactivated",
  "themeChanged",
  "viewportChanged",
  "safeAreaChanged",
  "contentSafeAreaChanged",
  "fullscreenChanged",
  "fullscreenFailed",
  "backButtonClicked",
  "mainButtonClicked",
  "secondaryButtonClicked",
  "settingsButtonClicked",
  "qrTextReceived",
  "qrScannerClosed",
];
const tick = () => new Promise((r) => setImmediate(r));
function host(overrides = {}) {
  const listeners = new Set(),
    messages = [],
    errors = [];
  const snapshot = {
    colorScheme: "dark",
    theme: { background: "#010203", text: "#ffffff" },
    viewportHeight: 640,
    stableViewportHeight: 620,
    safeArea: { top: 20, right: 0, bottom: 12, left: 0 },
    contentSafeArea: { top: 40, right: 0, bottom: 0, left: 0 },
    isFullscreen: false,
  };
  const port = {
    protocolVersion: 1,
    generation: "seed:document",
    launchData: "query_id=signed%2Bbytes",
    operations,
    capabilities: MINI_APP_CAPABILITIES,
    events,
    canonicalSnapshot: true,
    liveSnapshot: true,
    snapshot: () => snapshot,
    postMessage(raw) {
      messages.push(JSON.parse(raw));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    ...overrides,
  };
  const scope = { LO: { MiniAppNative: port } };
  Object.defineProperty(scope.LO, "WebApp", {
    get() {
      throw Error("legacy discovery forbidden");
    },
  });
  const emit = (fields) => {
    for (const fn of [...listeners])
      fn(
        JSON.stringify({
          channel: "lo.miniapp",
          version: 1,
          generation: port.generation,
          ...fields,
        }),
      );
  };
  const complete = (
    value = null,
    request = messages.findLast((x) => x.kind === "request"),
  ) => emit({ kind: "result", id: request.id, ok: true, value });
  const lease = () =>
    installTelegramCompatibility({ scope, onError: (e) => errors.push(e) });
  return {
    scope,
    port,
    messages,
    listeners,
    errors,
    snapshot,
    emit,
    complete,
    lease,
  };
}
test("canonical discovery never uses the old alias", async () => {
  assert.throws(() => installTelegramCompatibility(), /error handler/);
  for (const scope of [{}, { LO: { WebApp: { initData: "old" } } }])
    assert.equal(installTelegramCompatibility({ scope, onError() {} }), null);
  const h = host(),
    a = h.lease();
  assert.ok(a.installed);
  assert.equal(h.scope.Telegram.WebApp, a.webApp);
  assert.equal(a.webApp.initData, h.port.launchData);
  assert.equal(a.webApp.initDataUnsafe.query_id, "signed+bytes");
  await a.dispose();
  assert.equal(Object.hasOwn(h.scope, "Telegram"), false);
});
test("legacy calls produce canonical operation and input envelopes", async () => {
  const h = host(),
    a = h.lease(),
    w = a.webApp;
  const cases = [
    ...[
      "ready",
      "close",
      "expand",
      "requestFullscreen",
      "exitFullscreen",
      "hideKeyboard",
    ].map((name) => [() => w[name](), name, undefined]),
    [() => w.lockOrientation(), "setOrientationLock", { locked: true }],
    [() => w.unlockOrientation(), "setOrientationLock", { locked: false }],
    ...["ClosingConfirmation", "VerticalSwipes"].flatMap((name) =>
      ["enable", "disable"].map((verb) => [
        () => w[verb + name](),
        "set" + name,
        { enabled: verb === "enable" },
      ]),
    ),
    ...["Header", "Background", "BottomBar"].map((name) => [
      () => w["set" + name + "Color"]("#123456"),
      "set" + name + "Color",
      { color: "#123456" },
    ]),
    [
      () => w.openLink("https://example.com", { try_instant_view: true }),
      "openLink",
      { url: "https://example.com", instantView: true },
    ],
    [() => w.sendData("data"), "sendData", { data: "data" }],
    [
      () => w.switchInlineQuery("query", ["users"]),
      "switchInlineQuery",
      { query: "query", chatTypes: ["users"] },
    ],
    [
      () =>
        w.shareToStory("https://example.com/a.png", {
          text: "caption",
          widget_link: { url: "https://example.com", name: "Visit" },
        }),
      "shareToStory",
      {
        mediaUrl: "https://example.com/a.png",
        params: {
          text: "caption",
          link: { url: "https://example.com", name: "Visit" },
        },
      },
    ],
    ...[
      ["impactOccurred", "light"],
      ["notificationOccurred", "success"],
      ["selectionChanged", "selection"],
    ].map(([method, kind]) => [
      () => w.HapticFeedback[method](kind),
      "haptic",
      { kind },
    ]),
  ];
  for (const [invoke, op, input] of cases) {
    invoke();
    assert.equal(h.messages.at(-1).operation, op);
    assert.deepEqual(h.messages.at(-1).input, input);
    h.complete();
    await tick();
  }
  assert.deepEqual(h.errors, []);
  await a.dispose();
});
test("denial remains false, native failure is sanitized, last disposal cancels and joins", async () => {
  const h = host(),
    a = h.lease(),
    answers = [];
  a.webApp.requestWriteAccess((x) => answers.push(x));
  h.complete(false);
  await tick();
  assert.deepEqual(answers, [false]);
  a.webApp.requestContact((x) => answers.push(x));
  h.emit({
    kind: "result",
    id: h.messages.at(-1).id,
    ok: false,
    error: { code: "host_error", message: "PRIVATE" },
  });
  await tick();
  assert.equal(h.errors[0].error.code, "failed");
  assert.doesNotMatch(h.errors[0].error.message, /PRIVATE/);
  assert.deepEqual(answers, [false]);
  a.webApp.shareMessage("share-id", (x) => answers.push(x));
  const req = h.messages.at(-1);
  await a.dispose();
  assert.ok(h.messages.some((x) => x.kind === "cancel" && x.id === req.id));
  h.complete(true, req);
  await tick();
  assert.deepEqual(answers, [false]);
  assert.equal(h.listeners.size, 0);
});
test("popup, download, clipboard and invoice callback results", async () => {
  const h = host(),
    a = h.lease(),
    w = a.webApp,
    out = [];
  for (const [invoke, value] of [
    [
      () =>
        w.showPopup(
          { message: "Hi", buttons: [{ id: "x", type: "ok" }] },
          (x) => out.push(x),
        ),
      "x",
    ],
    [() => w.showAlert("Hi", () => out.push("closed")), null],
    [() => w.showConfirm("Sure", (x) => out.push(x)), "yes"],
    [() => w.readTextFromClipboard((x) => out.push(x)), null],
    [
      () =>
        w.downloadFile({ url: "https://example.com/a", file_name: "a" }, (x) =>
          out.push(x),
        ),
      false,
    ],
  ]) {
    invoke();
    h.complete(value);
    await tick();
  }
  assert.deepEqual(out, ["x", "closed", true, null, false]);
  assert.deepEqual(h.errors, []);
  await a.dispose();
});
test("storage conversion preserves errors and secure restore flags", async () => {
  const h = host(),
    a = h.lease(),
    w = a.webApp,
    out = [],
    cb = (...v) => out.push(v);
  const cases = [];
  for (const name of ["CloudStorage", "DeviceStorage", "SecureStorage"]) {
    cases.push(
      [() => w[name].setItem("k", "v", cb), true],
      [
        () => w[name].getItem("k", cb),
        name === "SecureStorage"
          ? { value: null, canRestore: true }
          : name === "CloudStorage"
            ? "v"
            : null,
      ],
      [() => w[name].removeItem("k", cb), true],
    );
    if (name !== "CloudStorage") cases.push([() => w[name].clear(cb), true]);
  }
  cases.push(
    [() => w.CloudStorage.getItems(["k"], cb), { k: "v" }],
    [() => w.CloudStorage.removeItems(["k"], cb), true],
    [() => w.CloudStorage.getKeys(cb), ["k"]],
    [() => w.SecureStorage.restoreItem("k", cb), "v"],
  );
  for (const [invoke, value] of cases) {
    invoke();
    h.complete(value);
    await tick();
  }
  assert.equal(out.length, 15);
  assert.ok(out.every((x) => x[0] === null));
  assert.ok(out.some((x) => x.length === 3 && x[1] === null && x[2] === true));
  w.CloudStorage.getItem("bad", cb);
  h.emit({
    kind: "result",
    id: h.messages.at(-1).id,
    ok: false,
    error: { code: "host_error", message: "PRIVATE" },
  });
  await tick();
  assert.equal(out.at(-1)[0].code, "failed");
  assert.deepEqual(h.errors, []);
  w.DeviceStorage.clear();
  h.emit({
    kind: "result",
    id: h.messages.at(-1).id,
    ok: false,
    error: { code: "host_error", message: "PRIVATE" },
  });
  await tick();
  assert.equal(h.errors.length, 1);
  await a.dispose();
});
test("buttons preserve chaining and mapped parameters", async () => {
  const h = host(),
    a = h.lease();
  for (const [name, id] of [
    ["MainButton", "main"],
    ["SecondaryButton", "secondary"],
    ["BackButton", "back"],
    ["SettingsButton", "settings"],
  ]) {
    const b = a.webApp[name];
    for (const invoke of [
      () => b.show(),
      () => b.hide(),
      () => b.enable(),
      () => b.disable(),
      () => b.setText("Hi"),
      () =>
        b.setParams({
          text: "Hi",
          text_color: "#ffffff",
          is_active: true,
          is_visible: true,
          has_shine_effect: true,
          position: "left",
        }),
      () => b.showProgress(true),
      () => b.hideProgress(),
    ]) {
      assert.equal(invoke(), b);
      assert.equal(h.messages.at(-1).input.button, id);
      h.complete();
      await tick();
    }
    const fn = () => {};
    assert.equal(b.onClick(fn), b);
    assert.equal(b.offClick(fn), b);
  }
  await a.dispose();
});
test("snapshot/event mapping does not invent expansion, stability or versions", async () => {
  const h = host(),
    a = h.lease(),
    w = a.webApp;
  assert.equal(w.colorScheme, "dark");
  assert.deepEqual(w.themeParams, {
    bg_color: "#010203",
    text_color: "#ffffff",
  });
  assert.equal(w.viewportHeight, 640);
  assert.equal(w.viewportStableHeight, 620);
  assert.equal(w.isFullscreen, false);
  assert.deepEqual(w.contentSafeAreaInset, {
    top: 60,
    right: 0,
    bottom: 12,
    left: 0,
  });
  assert.equal(w.safeAreaInset.top, 20);
  for (const name of [
    "version",
    "platform",
    "isExpanded",
    "BiometricManager",
    "LocationManager",
    "Accelerometer",
    "Gyroscope",
    "DeviceOrientation",
  ])
    assert.throws(() => w[name], { code: "unsupported" });
  for (const name of [
    "isVersionAtLeast",
    "openTelegramLink",
    "showScanQrPopup",
    "closeScanQrPopup",
    "addToHomeScreen",
    "checkHomeScreenStatus",
  ])
    assert.throws(() => w[name](), { code: "unsupported" });
  assert.throws(() => w.MainButton.showProgress(), { code: "unsupported" });
  assert.throws(() => w.MainButton.setParams({ invented: true }), {
    code: "unsupported",
  });
  assert.throws(() => w.openLink("https://example.com", { invented: true }), {
    code: "unsupported",
  });
  assert.throws(() => w.close({ return_back: true }), { code: "unsupported" });
  assert.throws(
    () => w.openLink("https://example.com", { try_browser: "chrome" }),
    { code: "unsupported" },
  );
  assert.ok(!w.capabilities.includes("sensors"));
  assert.throws(() => w.openInvoice("https://example.com/invoice"), {
    code: "unsupported",
  });
  assert.equal(h.messages.length, 0);
  const out = [],
    fn = (...v) => out.push(v);
  for (const e of [
    "themeChanged",
    "viewportChanged",
    "fullscreenFailed",
    "mainButtonClicked",
  ]) {
    w.onEvent(e, fn);
    w.onEvent(e, fn);
  }
  h.emit({ kind: "event", event: "themeChanged", payload: h.snapshot });
  h.emit({ kind: "event", event: "viewportChanged", payload: h.snapshot });
  h.emit({
    kind: "event",
    event: "fullscreenFailed",
    payload: { reason: "unsupported" },
  });
  h.emit({ kind: "event", event: "mainButtonClicked" });
  assert.deepEqual(out, [
    [],
    [{ isStateStable: undefined }],
    [{ error: "unsupported" }],
    [],
  ]);
  for (const e of [
    "themeChanged",
    "viewportChanged",
    "fullscreenFailed",
    "mainButtonClicked",
  ])
    w.offEvent(e, fn);
  await a.dispose();
});
test("unsupported calls refuse before sending and request/listener budgets hold", async () => {
  const h = host({
      operations: ["ready"],
      capabilities: ["ready"],
      events: [],
    }),
    a = h.lease();
  assert.throws(() => a.webApp.expand(), { code: "unsupported" });
  assert.throws(() => a.webApp.onEvent("mainButtonClicked", () => {}), {
    code: "unsupported",
  });
  assert.throws(() => a.webApp.onEvent("invented", () => {}), {
    code: "unsupported",
  });
  assert.equal(h.messages.length, 0);
  for (let n = 0; n < COMPATIBILITY_LIMITS.requests; n++) a.webApp.ready();
  assert.throws(() => a.webApp.ready(), /limit/);
  await a.dispose();
  const b = host(),
    c = b.lease();
  for (let n = 0; n < COMPATIBILITY_LIMITS.listeners; n++)
    c.webApp.onEvent("mainButtonClicked", () => {});
  assert.throws(() => c.webApp.onEvent("mainButtonClicked", () => {}), /limit/);
  await c.dispose();
});
test("multiple leases and signal disposal preserve active owners", async () => {
  const h = host(),
    a = h.lease(),
    s = new AbortController(),
    b = installTelegramCompatibility({
      scope: h.scope,
      onError() {},
      signal: s.signal,
    });
  await a.dispose();
  assert.equal(a.installed, false);
  assert.equal(b.installed, true);
  s.abort();
  await b.dispose();
  assert.equal(Object.hasOwn(h.scope, "Telegram"), false);
  assert.throws(() => b.webApp.ready(), { code: "disposed" });
  assert.throws(
    () =>
      installTelegramCompatibility({
        scope: h.scope,
        onError() {},
        signal: s.signal,
      }),
    { code: "aborted" },
  );
});
test("replacement of global, descriptor, generation, port or assertion fences late work", async () => {
  for (const change of [
    (h) => {
      h.scope.Telegram = { WebApp: { replacement: true } };
    },
    (h) => {
      h.scope.Telegram.WebApp = { replacement: true };
    },
    (h) => {
      Object.defineProperty(h.scope.Telegram, "WebApp", { writable: false });
    },
    (h) => {
      h.port.generation = "new:document";
    },
    (h) => {
      h.port.launchData = "new";
    },
    (h) => {
      h.scope.LO.MiniAppNative = { ...h.port };
    },
  ]) {
    const h = host(),
      a = h.lease();
    let calls = 0;
    a.webApp.requestContact(() => calls++);
    const req = h.messages.at(-1);
    change(h);
    assert.equal(a.installed, false);
    assert.throws(() => h.lease(), { code: "disposed" });
    assert.throws(() => a.webApp.ready(), { code: "disposed" });
    h.complete(true, req);
    await tick();
    assert.equal(calls, 0);
    await a.dispose();
    assert.equal(h.listeners.size, 0);
  }
});
test("foreign globals, accessors and exact descriptors are preserved", async () => {
  const h = host(),
    container = { extra: 42 },
    d = {
      value: undefined,
      writable: false,
      configurable: true,
      enumerable: false,
    };
  Object.defineProperty(container, "WebApp", d);
  h.scope.Telegram = container;
  const a = h.lease();
  await a.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(container, "WebApp"), d);
  const b = host(),
    c = b.lease();
  b.scope.Telegram.other = 42;
  await c.dispose();
  assert.deepEqual(b.scope.Telegram, { other: 42 });
  for (const value of [null, 42, { WebApp: {} }]) {
    const x = host();
    x.scope.Telegram = value;
    assert.throws(() => x.lease());
    assert.equal(x.scope.Telegram, value);
  }
  const e = host();
  Object.defineProperty(e.scope, "Telegram", {
    get() {
      throw Error("must not read");
    },
  });
  assert.throws(() => e.lease(), /accessor/);
  const f = host();
  Object.freeze(f.scope);
  assert.throws(() => f.lease());
});
test("callback errors are observed without private cause and shared leases each see failures", async () => {
  const h = host(),
    a = h.lease(),
    other = [],
    b = installTelegramCompatibility({
      scope: h.scope,
      onError: (e) => other.push(e),
    });
  a.webApp.requestContact(() => {
    throw Error("SECRET");
  });
  h.complete(true);
  await tick();
  assert.equal(h.errors.length, 1);
  assert.equal(other.length, 1);
  assert.doesNotMatch(h.errors[0].error.message, /SECRET/);
  a.webApp.onEvent("mainButtonClicked", () => {
    throw Error("SECRET");
  });
  h.emit({ kind: "event", event: "mainButtonClicked" });
  assert.equal(h.errors.length, 2);
  await a.dispose();
  await b.dispose();
});

test("lease bound, missing snapshot values and omitted callbacks remain explicit", async () => {
  const h = host(),
    leases = [];
  for (let n = 0; n < COMPATIBILITY_LIMITS.leases; n++) leases.push(h.lease());
  assert.throws(() => h.lease(), /limit/);
  const w = leases[0].webApp;
  delete h.snapshot.theme;
  delete h.snapshot.safeArea;
  assert.deepEqual(w.themeParams, {});
  assert.equal(w.contentSafeAreaInset, undefined);
  assert.equal(w.headerColor, undefined);
  assert.equal(w.backgroundColor, undefined);
  assert.equal(w.bottomBarColor, undefined);
  assert.equal(w.isOrientationLocked, undefined);
  for (const name of [
    "isActive",
    "isClosingConfirmationEnabled",
    "isVerticalSwipesEnabled",
  ])
    assert.throws(() => w[name], { code: "unsupported" });
  w.showPopup({ message: "No callback" });
  h.complete(null);
  await tick();
  w.showConfirm("No callback");
  h.complete(null);
  await tick();
  w.CloudStorage.setItem("k", "v");
  h.complete(true);
  await tick();
  w.offEvent("absent", () => {});
  assert.throws(() => w.onEvent("themeChanged", null), TypeError);
  for (const lease of leases) await lease.dispose();
});

test("rejected async callbacks and native failures never escape as unhandled rejections", async () => {
  const unhandled = [];
  const observe = (e) => unhandled.push(e);
  process.on("unhandledRejection", observe);
  try {
    const h = host(),
      a = h.lease();
    a.webApp.requestContact(async () => {
      throw Error("PRIVATE callback");
    });
    h.complete(true);
    await tick();
    await tick();
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0].error.message, "Compatibility callback failed");
    a.webApp.onEvent("mainButtonClicked", async () => {
      throw Error("PRIVATE event callback");
    });
    h.emit({ kind: "event", event: "mainButtonClicked" });
    await tick();
    await tick();
    assert.equal(h.errors.length, 2);
    a.webApp.ready();
    h.emit({
      kind: "result",
      id: h.messages.at(-1).id,
      ok: false,
      error: { code: "host_error", message: "PRIVATE native" },
    });
    await tick();
    assert.equal(h.errors.length, 3);
    await a.dispose();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", observe);
  }
});

test("throwing or rejecting mandatory error sinks become one sanitized uncaught error", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const asynchronous of [false, true]) {
    const source = `import {installTelegramCompatibility} from ${JSON.stringify(import.meta.resolve("@lo-ink/adapter-telegram-to-lo"))};
 const uncaught=[],unhandled=[];process.on('uncaughtException',e=>uncaught.push({code:e.code,message:e.message}));process.on('unhandledRejection',e=>unhandled.push(String(e)));let receive;const port={protocolVersion:1,generation:'seed:doc',launchData:'query_id=x',operations:['ready'],capabilities:['ready'],snapshot:()=>({}),subscribe(fn){receive=fn;return()=>{};},postMessage(raw){const r=JSON.parse(raw);if(r.kind==='request')queueMicrotask(()=>receive(JSON.stringify({...r,kind:'result',ok:false,error:{code:'host_error',message:'SECRET native'},operation:undefined,input:undefined})));}};
 const lease=installTelegramCompatibility({scope:{LO:{MiniAppNative:port}},onError:${asynchronous ? "async " : ""}()=>{throw Error('SECRET sink');}});lease.webApp.ready();await new Promise(r=>setTimeout(r,20));await lease.dispose();console.log(JSON.stringify({uncaught,unhandled}));`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", source],
      { encoding: "utf8", timeout: 3000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const proof = JSON.parse(result.stdout);
    assert.deepEqual(proof, {
      uncaught: [
        { code: "failed", message: "Compatibility error handler failed" },
      ],
      unhandled: [],
    });
  }
});

test("inherited foreign globals and accessors are refused without evaluation", () => {
  for (const accessor of [false, true]) {
    for (const inheritedNamespace of [false, true]) {
      const h = host();
      let reads = 0;
      const ancestor = {};
      Object.defineProperty(
        ancestor,
        inheritedNamespace ? "Telegram" : "WebApp",
        accessor
          ? {
              get() {
                reads++;
                throw Error("private getter");
              },
            }
          : {
              value: inheritedNamespace
                ? { WebApp: { foreign: true } }
                : { foreign: true },
            },
      );
      if (inheritedNamespace) Object.setPrototypeOf(h.scope, ancestor);
      else h.scope.Telegram = Object.create(ancestor);
      assert.throws(() => h.lease(), /inherited/);
      assert.equal(reads, 0);
      assert.equal(
        Object.hasOwn(
          inheritedNamespace ? h.scope : h.scope.Telegram,
          inheritedNamespace ? "Telegram" : "WebApp",
        ),
        false,
      );
    }
  }
});
