import {
  createLoClient,
  MiniAppError,
  type LoNativeGlobal,
  type LoMiniAppNativePort,
} from "@lo-ink/miniapp-sdk";
import {
  createFacade,
  COMPATIBILITY_LIMITS,
  type Failure,
  type TelegramWebApp,
} from "./facade.js";
export { COMPATIBILITY_LIMITS } from "./facade.js";
export type { Failure, TelegramWebApp } from "./facade.js";

export type TelegramCompatibilityScope = LoNativeGlobal & {
  Telegram?: { WebApp?: unknown; [key: string]: unknown };
};
export interface TelegramCompatibilityOptions {
  scope?: TelegramCompatibilityScope;
  /** Required sink for asynchronous failures of callback/void APIs. Must not throw. */
  onError(failure: Failure): void;
  signal?: AbortSignal;
}
export interface TelegramCompatibility {
  readonly installed: boolean;
  readonly webApp: TelegramWebApp;
  /** Last lease cancels requests, removes subscriptions and joins their settlement. */
  dispose(): Promise<void>;
}
type Lease = { onError(failure: Failure): void };
type Installation = {
  port: LoMiniAppNativePort;
  launchData: string;
  generation: string;
  leases: Set<Lease>;
  webApp: TelegramWebApp;
  owns(): boolean;
  live(): boolean;
  stop(): Promise<void>;
};
const installations = new WeakMap<object, Installation>();
const sameDescriptor = (
  a: PropertyDescriptor | undefined,
  b: PropertyDescriptor,
) =>
  !!a &&
  a.value === b.value &&
  a.get === b.get &&
  a.set === b.set &&
  a.writable === b.writable &&
  a.enumerable === b.enumerable &&
  a.configurable === b.configurable;

function notify(handler: (failure: Failure) => void, failure: Failure): void {
  const fault = () =>
    queueMicrotask(() => {
      throw new MiniAppError("failed", "Compatibility error handler failed");
    });
  try {
    const result: unknown = handler(failure);
    // JavaScript callers can return a Promise despite the synchronous contract.
    // Observe its rejection; report sink failures as uncaught programming errors.
    if (result && typeof (result as PromiseLike<unknown>).then === "function")
      void Promise.resolve(result).catch(fault);
  } catch {
    fault();
  }
}

/** Explicit inbound facade. Native discovery only; never loads or aliases another SDK. */
export function installTelegramCompatibility(
  options: TelegramCompatibilityOptions,
): TelegramCompatibility | null {
  if (!options || typeof options.onError !== "function")
    throw new TypeError("A compatibility error handler is required");
  if (options.signal?.aborted) throw new MiniAppError("aborted");
  const scope = options.scope ?? (globalThis as TelegramCompatibilityScope);
  const prior = installations.get(scope);
  if (prior && !prior.live())
    throw new MiniAppError(
      "disposed",
      "Dispose the previous installation before reinstalling",
    );
  const port = scope.LO?.MiniAppNative;
  const client = createLoClient({ LO: { MiniAppNative: port } });
  if (!client || !port) return null;
  let installation: Installation;
  if (prior) {
    client.dispose();
    if (!prior.live() || prior.port !== port)
      throw new MiniAppError(
        "disposed",
        "Dispose the previous installation before reinstalling",
      );
    installation = prior;
  } else {
    const originalNamespace = Object.getOwnPropertyDescriptor(
      scope,
      "Telegram",
    );
    if (!originalNamespace && "Telegram" in scope) {
      client.dispose();
      throw new TypeError("Cannot shadow an inherited Telegram global");
    }
    // Accessors belong to another owner; never execute them as discovery hooks.
    if (originalNamespace && !("value" in originalNamespace)) {
      client.dispose();
      throw new TypeError("Cannot replace a Telegram accessor");
    }
    const existing = originalNamespace?.value;
    if (existing !== undefined && (!existing || typeof existing !== "object")) {
      client.dispose();
      throw new TypeError("Cannot replace an existing Telegram global");
    }
    const container = existing ?? {};
    const originalWebApp = Object.getOwnPropertyDescriptor(container, "WebApp");
    if (!originalWebApp && "WebApp" in container) {
      client.dispose();
      throw new TypeError("Cannot shadow an inherited Telegram WebApp");
    }
    if (
      originalWebApp &&
      (!("value" in originalWebApp) || originalWebApp.value !== undefined)
    ) {
      client.dispose();
      throw new TypeError("Cannot replace an existing Telegram WebApp");
    }
    const target = existing ? container : scope;
    const property = existing ? "WebApp" : "Telegram";
    const original = existing ? originalWebApp : originalNamespace;
    const leases = new Set<Lease>();
    const launchData = client.adapter.launchData,
      generation = port.generation;
    let stopped = false,
      installed: PropertyDescriptor,
      installedWebApp: PropertyDescriptor;
    const owns = () =>
      !!installed &&
      sameDescriptor(
        Object.getOwnPropertyDescriptor(target, property),
        installed,
      ) &&
      sameDescriptor(
        Object.getOwnPropertyDescriptor(container, "WebApp"),
        installedWebApp,
      ) &&
      sameDescriptor(
        Object.getOwnPropertyDescriptor(scope, "Telegram"),
        existing ? originalNamespace! : installed,
      );
    const live = () => {
      try {
        return (
          !stopped &&
          owns() &&
          scope.LO?.MiniAppNative === port &&
          port.generation === generation &&
          port.launchData === launchData
        );
      } catch {
        return false;
      }
    };
    const facade = createFacade(client, live, (failure) => {
      for (const lease of [...leases]) notify(lease.onError, failure);
    });
    try {
      if (!existing)
        Object.defineProperty(container, "WebApp", {
          value: facade.webApp,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      Object.defineProperty(target, property, {
        value: existing ? facade.webApp : container,
        enumerable: original?.enumerable ?? true,
        configurable: true,
        writable: true,
      });
      installed = Object.getOwnPropertyDescriptor(target, property)!;
      installedWebApp = Object.getOwnPropertyDescriptor(container, "WebApp")!;
    } catch (error) {
      client.dispose();
      throw error;
    }
    let completion: Promise<void> | undefined;
    installation = {
      port,
      launchData,
      generation,
      leases,
      webApp: facade.webApp,
      owns,
      live,
      stop() {
        if (completion) return completion;
        completion = (async () => {
          stopped = true;
          try {
            if (owns()) {
              if (
                !existing &&
                Reflect.ownKeys(container).some((key) => key !== "WebApp")
              )
                Reflect.deleteProperty(container, "WebApp");
              else if (original)
                Object.defineProperty(target, property, original);
              else Reflect.deleteProperty(target, property);
            }
          } finally {
            installations.delete(scope);
            await facade.stop();
          }
        })();
        return completion;
      },
    };
    installations.set(scope, installation);
  }
  if (installation.leases.size >= COMPATIBILITY_LIMITS.leases)
    throw new MiniAppError("failed", "Compatibility lease limit reached");
  const lease: Lease = { onError: options.onError };
  installation.leases.add(lease);
  let released = false;
  const dispose = () => {
    if (!released) {
      released = true;
      options.signal?.removeEventListener("abort", abort);
      installation.leases.delete(lease);
    }
    return installation.leases.size === 0
      ? installation.stop()
      : Promise.resolve();
  };
  const abort = () => {
    void dispose().catch(() =>
      notify(options.onError, {
        operation: "dispose",
        error: new MiniAppError("failed", "Compatibility cleanup failed"),
      }),
    );
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    get installed() {
      return !released && installation.live();
    },
    webApp: installation.webApp,
    dispose,
  };
}
