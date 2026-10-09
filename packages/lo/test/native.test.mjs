import test from "node:test";
import assert from "node:assert/strict";
import { createMiniAppClient } from "@lo-ink/miniapp-sdk";
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

test("native discovery never reads a WebApp fallback", async () => {
  const sdk = await import("@lo-ink/miniapp-sdk");
  const host = nativePort();
  const scope = {
    LO: {
      MiniAppNative: host.port,
      get WebApp() {
        throw new Error("Retired transport accessed");
      },
    },
  };
  const client = sdk.createLoClient(scope);
  assert.ok(client);
  client.dispose();
  delete scope.LO.MiniAppNative;
  assert.equal(createAdapter(scope), null);
  assert.equal(sdk.createLoClient(scope), null);
});
