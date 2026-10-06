import test from "node:test";
import assert from "node:assert/strict";
import { createMiniAppClient } from "@lo-ink/miniapp-sdk";
import { createAdapter, createNativeAdapter } from "../dist/index.js";
import { createAdapter as createLegacyAdapter } from "../../lo-legacy/dist/index.js";

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

test("legacy selection uses selectionChanged without an impact argument", async () => {
  const calls = [];
  const adapter = createLegacyAdapter({
    LO: {
      WebApp: {
        initData: "legacy",
        capabilities: ["haptics"],
        HapticFeedback: {
          selectionChanged: (...args) => calls.push(args),
        },
      },
    },
  });
  await createMiniAppClient(adapter).call("haptic", { kind: "selection" });
  assert.deepEqual(calls, [[]]);
});

test("explicit WebApp selection never fills missing buttons from native transport", async () => {
  const host = nativePort({
    operations: ["setButton"],
    capabilities: ["backButton"],
  });
  const legacyCalls = [];
  const adapter = createLegacyAdapter({
    LO: {
      MiniAppNative: host.port,
      WebApp: {
        initData: "signed-launch",
        capabilities: ["mainButton"],
        MainButton: {
          setParams(params) {
            legacyCalls.push(params);
          },
        },
      },
    },
  });
  const client = createMiniAppClient(adapter);

  await client.call("setButton", {
    button: "main",
    params: { text: "Legacy main" },
  });
  assert.equal(host.messages.length, 0);
  assert.equal(legacyCalls[0].text, "Legacy main");

  await assert.rejects(
    client.call("setButton", { button: "back", params: { visible: true } }),
    { code: "unsupported" },
  );
  assert.equal(host.messages.length, 0);
});

test("legacy selection never inspects a native port or merges capabilities", async () => {
  let expanded = 0;
  const adapter = createLegacyAdapter({
    LO: {
      get MiniAppNative() {
        throw new Error("Legacy discovery must not inspect native transport");
      },
      WebApp: {
        initData: "legacy",
        capabilities: ["expand"],
        expand() {
          expanded += 1;
        },
      },
    },
  });
  assert.equal(adapter.id, "lo-legacy-webapp");
  assert.deepEqual([...adapter.capabilities], ["expand"]);
  const client = createMiniAppClient(adapter);
  await client.call("expand", undefined);
  assert.equal(expanded, 1);
  await assert.rejects(client.call("ready", undefined), {
    code: "unsupported",
  });
  client.dispose();
});

test("legacy discovery returns null for a native-only host", () => {
  assert.equal(
    createLegacyAdapter({ LO: { MiniAppNative: nativePort().port } }),
    null,
  );
});

test("compatibility exports resolve the canonical SDK implementation", async () => {
  const sdk = await import("@lo-ink/miniapp-sdk");
  assert.equal(createNativeAdapter, sdk.createNativeAdapter);
  assert.equal(createAdapter, sdk.createNativeAdapter);
  const host = nativePort({ operations: ["expand"], capabilities: ["expand"] });
  const scope = { LO: { MiniAppNative: host.port } };
  const client = sdk.createLoClient(scope);
  const second = createMiniAppClient(createAdapter(scope));
  const pending = [
    client.call("expand", undefined),
    second.call("expand", undefined),
  ];
  assert.equal(host.listeners.size, 1);
  for (const request of host.messages)
    result(host, request, { ok: true, value: null });
  await Promise.all(pending);
  assert.equal(host.listeners.size, 0);
  client.dispose();
  second.dispose();
});
