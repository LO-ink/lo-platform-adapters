import type {
  Capability,
  HostSnapshot,
  MiniAppAdapter,
  MiniAppEvent,
  MiniAppEventMap,
  MiniAppOperation,
  OperationInput,
  RequestContext,
} from "@lo-ink/miniapp-sdk";
import {
  createWebAppAdapter,
  webAppCapabilities,
} from "@lo-ink/adapter-webapp-compat";
import type { LegacyWebApp } from "@lo-ink/adapter-webapp-compat";
import {
  createNativeAdapter,
  type LoMiniAppNativePort,
  type LoNativeAdapter,
} from "./native.js";

export {
  createNativeAdapter,
  type LoMiniAppNativePort,
  type LoNativeAdapter,
  type LoNativeGlobal,
  type LoNativeOperation,
} from "./native.js";

export type LoLegacyGlobal = { LO?: { WebApp?: LegacyWebApp } };
export type LoGlobal = {
  LO?: {
    WebApp?: LegacyWebApp;
    MiniAppNative?: LoMiniAppNativePort;
  };
};

function createLegacyAdapter(scope: LoLegacyGlobal): MiniAppAdapter | null {
  const webApp = scope.LO?.WebApp;
  if (!webApp || typeof webApp.initData !== "string" || !webApp.initData) {
    return null;
  }
  return createWebAppAdapter(
    "lo-legacy-webapp",
    webApp,
    webAppCapabilities(webApp),
  );
}

function composeAdapters(
  native: LoNativeAdapter,
  legacy: MiniAppAdapter,
): MiniAppAdapter {
  const capabilities = new Set<Capability>([
    ...legacy.capabilities,
    ...native.capabilities,
  ]);
  return {
    id: "lo",
    launchData: native.launchData,
    capabilities,
    snapshot(): HostSnapshot {
      return native.canonicalSnapshot ? native.snapshot() : legacy.snapshot();
    },
    subscribe<K extends MiniAppEvent>(
      event: K,
      listener: (payload: MiniAppEventMap[K]) => void,
    ) {
      return native.nativeEvents.has(event)
        ? native.subscribe(event, listener)
        : legacy.subscribe(event, listener);
    },
    execute<K extends MiniAppOperation>(
      operation: K,
      input: OperationInput<K>,
      context: RequestContext,
    ) {
      if (native.nativeSupports(operation, input)) {
        return native.execute(operation, input, context);
      }
      return legacy.execute(operation, input, context);
    },
  };
}

/** Prefers the canonical native port and composes matching-session legacy coverage. */
export function createAdapter(
  scope: LoGlobal = globalThis as LoGlobal,
): MiniAppAdapter | null {
  const native = createNativeAdapter(scope);
  const legacy = createLegacyAdapter(scope);
  if (!native) return legacy;
  if (!legacy || legacy.launchData !== native.launchData) return native;
  return composeAdapters(native, legacy);
}

export const detectAdapter = createAdapter;
