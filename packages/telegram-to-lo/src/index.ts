import type { LegacyWebApp } from "@lo-ink/adapter-webapp-compat";

export type TelegramCompatibilityScope = {
  LO?: { WebApp?: LegacyWebApp };
  Telegram?: { WebApp?: LegacyWebApp; [key: string]: unknown };
};

export interface TelegramCompatibility {
  /** Still owns the installed global; this does not authenticate a user. */
  readonly installed: boolean;
  /** Releases this lease. The final lease restores the original property. */
  dispose(): void;
}

type Installation = {
  source: LegacyWebApp;
  launchData: string;
  container: NonNullable<TelegramCompatibilityScope["Telegram"]>;
  owners: number;
  owns(): boolean;
  restore(): void;
};
const installations = new WeakMap<object, Installation>();

function sameDescriptor(
  current: PropertyDescriptor | undefined,
  installed: PropertyDescriptor,
): boolean {
  return (
    !!current &&
    current.value === installed.value &&
    current.get === installed.get &&
    current.set === installed.set &&
    current.writable === installed.writable &&
    current.enumerable === installed.enumerable &&
    current.configurable === installed.configurable
  );
}

/**
 * Opt-in bridge for an existing WebApp application running inside LO.
 * No script loading, API emulation, version inflation, or import-time mutation.
 * The native container must already provide the supported compatibility API.
 */
export function installTelegramCompatibility(
  scope: TelegramCompatibilityScope = globalThis as TelegramCompatibilityScope,
): TelegramCompatibility | null {
  let source: LegacyWebApp | undefined;
  try {
    source = scope.LO?.WebApp;
    if (
      !source ||
      typeof source !== "object" ||
      typeof source.initData !== "string" ||
      !source.initData ||
      !Array.isArray(source.capabilities) ||
      !source.capabilities.every((value) => typeof value === "string")
    )
      return null;
  } catch {
    return null;
  }
  const previous = installations.get(scope);
  let installation: Installation;
  if (previous) {
    if (
      previous.source !== source ||
      previous.launchData !== source.initData ||
      !previous.owns()
    )
      throw new Error(
        "Compatibility installation changed; dispose it before reinstalling",
      );
    installation = previous;
  } else {
    const existing = scope.Telegram;
    if (
      existing !== undefined &&
      (existing === null || typeof existing !== "object")
    )
      throw new TypeError("Cannot replace an existing Telegram global");
    if (existing?.WebApp !== undefined)
      throw new Error("Cannot replace an existing Telegram WebApp");
    const container = existing ?? {};
    const target: object = existing ?? scope;
    const property = existing ? "WebApp" : "Telegram";
    const original = Object.getOwnPropertyDescriptor(target, property);
    if (!existing) {
      Object.defineProperty(container, "WebApp", {
        value: source,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    Object.defineProperty(target, property, {
      value: existing ? source : container,
      enumerable: original?.enumerable ?? true,
      configurable: true,
      writable: true,
    });
    const installed = Object.getOwnPropertyDescriptor(target, property)!;
    const installedWebApp = Object.getOwnPropertyDescriptor(
      container,
      "WebApp",
    )!;
    const owns = () => {
      try {
        return (
          sameDescriptor(
            Object.getOwnPropertyDescriptor(target, property),
            installed,
          ) &&
          sameDescriptor(
            Object.getOwnPropertyDescriptor(container, "WebApp"),
            installedWebApp,
          ) &&
          scope.Telegram === container
        );
      } catch {
        return false;
      }
    };
    installation = {
      source,
      launchData: source.initData,
      container,
      owners: 0,
      owns,
      restore() {
        if (!owns()) return;
        if (
          !existing &&
          Reflect.ownKeys(container).some((key) => key !== "WebApp")
        ) {
          Reflect.deleteProperty(container, "WebApp");
          return;
        }
        if (original) Object.defineProperty(target, property, original);
        else Reflect.deleteProperty(target, property);
      },
    };
    installations.set(scope, installation);
  }
  installation.owners++;
  let active = true;
  return {
    get installed() {
      try {
        return (
          active &&
          installation.owns() &&
          scope.LO?.WebApp === installation.source &&
          installation.source.initData === installation.launchData
        );
      } catch {
        return false;
      }
    },
    dispose() {
      if (!active) return;
      active = false;
      installation.owners--;
      if (installation.owners) return;
      installations.delete(scope);
      installation.restore();
    },
  };
}
