import { MiniAppError, withHostCallback } from "@lo/miniapp-sdk";
import type { CallOptions, Capability, MiniAppAdapter } from "@lo/miniapp-sdk";
import { createWebAppAdapter } from "@lo/adapter-webapp-compat";
import type { LegacyWebApp } from "@lo/adapter-webapp-compat";

export type TelegramGlobal = { Telegram?: { WebApp?: LegacyWebApp } };
export type TelegramDocument = Pick<Document, "createElement" | "head">;
const MAX_TIMEOUT_MS = 2_147_483_647;

const capabilityVersions: Record<Capability, string> = {
  requestWriteAccess: "6.9",
  requestContact: "6.9",
  shareMessage: "8.0",
  shareToStory: "7.8",
  ready: "6.0",
  hideKeyboard: "9.1",
  switchInlineQuery: "6.7",
  clipboard: "6.4",
  orientation: "8.0",
  location: "8.0",
  biometry: "7.2",
  sensors: "8.0",
  downloadFile: "8.0",
  qrScanner: "6.4",
  cloudStorage: "6.9",
  deviceStorage: "9.0",
  secureStorage: "9.0",
  expand: "6.0",
  backButton: "6.1",
  mainButton: "6.0",
  secondaryButton: "7.10",
  settingsButton: "7.0",
  closingConfirmation: "6.2",
  headerColor: "6.9",
  backgroundColor: "6.1",
  bottomBarColor: "7.10",
  fullscreen: "8.0",
  haptics: "6.1",
  popup: "6.2",
  openLink: "6.1",
  sendData: "6.0",
  invoice: "6.1",
};

export interface TelegramAdapterExtensions {
  requestChat(id: string, options?: CallOptions): Promise<boolean>;
  setEmojiStatus(
    id: string,
    options?: CallOptions & { duration?: number },
  ): Promise<boolean>;
  openTelegramLink(url: string): void;
}

export interface TelegramMiniAppAdapter extends MiniAppAdapter {
  readonly telegram: TelegramAdapterExtensions;
}

export function isVersionAtLeast(
  actual: string | undefined,
  minimum: string,
): boolean {
  const parse = (value: string | undefined) =>
    value && /^\d+\.\d+(?:\.\d+)?$/.test(value)
      ? value.split(".").map(Number)
      : null;
  const left = parse(actual);
  const right = parse(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0))
      return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

export function createAdapter(
  scope: TelegramGlobal = globalThis as TelegramGlobal,
): TelegramMiniAppAdapter | null {
  const webApp = scope.Telegram?.WebApp;
  if (!webApp || typeof webApp.initData !== "string" || !webApp.initData)
    return null;
  const capabilities = new Set<Capability>();
  for (const [capability, version] of Object.entries(capabilityVersions) as [
    Capability,
    string,
  ][]) {
    if (
      isVersionAtLeast(webApp.version, version) &&
      (capability !== "invoice" || typeof webApp.openInvoice === "function")
    ) {
      capabilities.add(capability);
    }
  }
  const base = createWebAppAdapter("telegram", webApp, capabilities);
  const requireVersion = (minimum: string, name: string) => {
    if (
      !isVersionAtLeast(webApp.version, minimum) ||
      typeof webApp[name] !== "function"
    ) {
      throw new MiniAppError("unsupported", `${name} is unavailable`);
    }
  };
  return {
    ...base,
    telegram: {
      async requestChat(id, options = {}) {
        requireVersion("9.6", "requestChat");
        if (typeof id !== "string" || !id.length || id.length > 128) {
          return Promise.reject(new TypeError("Invalid prepared chat ID"));
        }
        return withHostCallback<boolean>((finish) => {
          webApp.requestChat(id, (sent: unknown) =>
            finish(null, sent === true),
          );
        }, options);
      },
      async setEmojiStatus(id, options = {}) {
        requireVersion("8.0", "setEmojiStatus");
        if (
          !/^[1-9][0-9]{0,19}$/.test(id) ||
          BigInt(id) > 18_446_744_073_709_551_615n
        ) {
          return Promise.reject(new TypeError("Invalid emoji status ID"));
        }
        const duration = options.duration ?? 3_600;
        if (!Number.isInteger(duration) || duration <= 0) {
          return Promise.reject(new TypeError("Invalid emoji status duration"));
        }
        return withHostCallback<boolean>((finish) => {
          webApp.setEmojiStatus(id, { duration }, (set: unknown) =>
            finish(null, set === true),
          );
        }, options);
      },
      openTelegramLink(url) {
        requireVersion("6.1", "openTelegramLink");
        webApp.openTelegramLink(url);
      },
    },
  };
}

export const detectAdapter = createAdapter;

const loads = new WeakMap<object, Promise<TelegramMiniAppAdapter | null>>();
export function loadAdapter(
  options: {
    scope?: TelegramGlobal;
    document?: TelegramDocument;
    timeoutMs?: number;
    scriptUrl?: string;
  } = {},
): Promise<TelegramMiniAppAdapter | null> {
  const scope = options.scope ?? (globalThis as TelegramGlobal);
  const detected = createAdapter(scope);
  if (detected) return Promise.resolve(detected);
  const document =
    options.document ??
    (globalThis as { document?: TelegramDocument }).document;
  if (!document) return Promise.resolve(null);
  const existing = loads.get(scope);
  if (existing) return existing;
  const timeoutMs = options.timeoutMs ?? 6_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    return Promise.reject(
      new RangeError(
        `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`,
      ),
    );
  }
  const result = new Promise<TelegramMiniAppAdapter | null>((resolve) => {
    const script = document.createElement("script");
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      script.remove();
      resolve(createAdapter(scope));
    };
    const timer = setTimeout(finish, timeoutMs);
    script.src =
      options.scriptUrl ?? "https://telegram.org/js/telegram-web-app.js";
    script.async = true;
    script.onload = finish;
    script.onerror = finish;
    try {
      document.head.append(script);
    } catch {
      finish();
    }
  }).finally(() => {
    loads.delete(scope);
  });
  loads.set(scope, result);
  return result;
}
