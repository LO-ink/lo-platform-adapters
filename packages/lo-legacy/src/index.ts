import type { MiniAppAdapter } from "@lo-ink/miniapp-sdk";
import {
  createWebAppAdapter,
  webAppCapabilities,
} from "@lo-ink/adapter-webapp-compat";
import type { LegacyWebApp } from "@lo-ink/adapter-webapp-compat";
import type { LoMiniAppNativePort } from "@lo-ink/adapter-lo";

export {
  createNativeAdapter,
  type LoMiniAppNativePort,
  type LoNativeAdapter,
  type LoNativeGlobal,
  type LoNativeOperation,
} from "@lo-ink/adapter-lo";

export type LoLegacyGlobal = { LO?: { WebApp?: LegacyWebApp } };
export type LoGlobal = {
  LO?: { WebApp?: LegacyWebApp; MiniAppNative?: LoMiniAppNativePort };
};

/** Selects the WebApp transport explicitly; it never inspects the native port. */
export function createAdapter(
  scope: LoLegacyGlobal = globalThis as LoLegacyGlobal,
): MiniAppAdapter | null {
  const webApp = scope.LO?.WebApp;
  if (!webApp || typeof webApp.initData !== "string" || !webApp.initData)
    return null;
  return createWebAppAdapter(
    "lo-legacy-webapp",
    webApp,
    webAppCapabilities(webApp),
  );
}

export const detectAdapter = createAdapter;
