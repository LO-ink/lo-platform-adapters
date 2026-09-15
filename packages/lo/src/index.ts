import type { MiniAppAdapter } from "@lo/miniapp-sdk";
import {
  createWebAppAdapter,
  webAppCapabilities,
} from "@lo/adapter-webapp-compat";
import type { LegacyWebApp } from "@lo/adapter-webapp-compat";

export type LoLegacyGlobal = { LO?: { WebApp?: LegacyWebApp } };

/** Wraps the compatibility object currently injected by LO. No native bridge is claimed. */
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
