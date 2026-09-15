import bridge from "@vkontakte/vk-bridge";
import type { VKBridge } from "@vkontakte/vk-bridge";
import { MiniAppError } from "@lo/miniapp-sdk";
import type {
  Capability,
  HostSnapshot,
  Insets,
  MiniAppAdapter,
  MiniAppEvent,
  MiniAppEventMap,
  MiniAppOperation,
  OperationInput,
  OperationOutput,
  RequestContext,
} from "@lo/miniapp-sdk";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const CAPABILITIES: ReadonlySet<Capability> = new Set(["ready"]);
const CONFIG_SCHEMES = new Set([
  "vkcom_light",
  "vkcom_dark",
  "space_gray",
  "bright_light",
]);

export type VkBridgePort = Pick<
  VKBridge,
  "send" | "subscribe" | "unsubscribe" | "isEmbedded"
>;

export interface VkAdapterOptions {
  /** Bridge instance to use. Defaults to the installed official singleton. */
  bridge?: VkBridgePort;
  /** Opaque launch query or payload passed through without parsing. */
  launchData?: string;
  /** Cancels factory initialization while waiting for the host. */
  signal?: AbortSignal;
  /** Total time allowed for initialization and the initial config request. */
  timeoutMs?: number;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function normalizeInsets(value: unknown): Insets | undefined {
  const object = record(value);
  if (!object) return undefined;
  const entries = [object.top, object.right, object.bottom, object.left];
  if (
    !entries.every(
      (entry) =>
        typeof entry === "number" && Number.isFinite(entry) && entry >= 0,
    )
  ) {
    return undefined;
  }
  return {
    top: object.top as number,
    right: object.right as number,
    bottom: object.bottom as number,
    left: object.left as number,
  };
}

function normalizeConfig(value: unknown): HostSnapshot | null {
  const object = record(value);
  if (
    !object ||
    typeof object.app_id !== "string" ||
    !object.app_id ||
    (object.appearance !== "light" && object.appearance !== "dark") ||
    typeof object.scheme !== "string" ||
    !CONFIG_SCHEMES.has(object.scheme)
  ) {
    return null;
  }

  let viewportHeight: number | undefined;
  if (object.viewport_height !== undefined) {
    if (
      typeof object.viewport_height !== "number" ||
      !Number.isFinite(object.viewport_height) ||
      object.viewport_height < 0
    ) {
      return null;
    }
    viewportHeight = object.viewport_height;
  }

  let safeArea: Insets | undefined;
  if (object.insets !== undefined) {
    safeArea = normalizeInsets(object.insets);
    if (!safeArea) return null;
  }

  return {
    colorScheme: object.appearance,
    ...(viewportHeight !== undefined ? { viewportHeight } : {}),
    ...(safeArea ? { safeArea } : {}),
  };
}

function copySnapshot(value: HostSnapshot): HostSnapshot {
  return {
    ...value,
    ...(value.theme ? { theme: { ...value.theme } } : {}),
    ...(value.safeArea ? { safeArea: { ...value.safeArea } } : {}),
    ...(value.contentSafeArea
      ? { contentSafeArea: { ...value.contentSafeArea } }
      : {}),
  };
}

function validateSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  const candidate = record(value);
  if (
    !candidate ||
    typeof candidate.aborted !== "boolean" ||
    typeof candidate.addEventListener !== "function" ||
    typeof candidate.removeEventListener !== "function"
  ) {
    throw new TypeError("signal must be an AbortSignal");
  }
  return value as AbortSignal;
}

function bounded<T>(
  start: () => PromiseLike<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new MiniAppError("aborted"));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new MiniAppError("timeout"));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let listening = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopListening = () => {
      if (!listening) return;
      listening = false;
      try {
        signal?.removeEventListener("abort", abort);
      } catch {
        // Signal cleanup must not change or delay the request outcome.
      }
    };
    const finish = (
      outcome: { ok: true; value: T } | { ok: false; error: unknown },
    ) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      stopListening();
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.error);
    };
    const abort = () =>
      finish({ ok: false, error: new MiniAppError("aborted") });
    try {
      listening = signal !== undefined;
      signal?.addEventListener("abort", abort, { once: true });
      if (settled) return;
      if (signal?.aborted) {
        abort();
        return;
      }
    } catch (cause) {
      finish({
        ok: false,
        error: new MiniAppError(
          "failed",
          "Abort signal listener registration failed.",
          { cause },
        ),
      });
      return;
    }
    timer = setTimeout(
      () => finish({ ok: false, error: new MiniAppError("timeout") }),
      remaining,
    );
    queueMicrotask(() => {
      if (settled) return;
      let request: PromiseLike<T>;
      try {
        request = start();
      } catch (error) {
        finish({ ok: false, error });
        return;
      }
      Promise.resolve(request).then(
        (value) => finish({ ok: true, value }),
        (error) => finish({ ok: false, error }),
      );
    });
  });
}

function eventDetail(value: unknown): { type: string; data: unknown } | null {
  const detail = record(record(value)?.detail);
  return detail && typeof detail.type === "string"
    ? { type: detail.type, data: detail.data }
    : null;
}

function makeAdapter(
  host: VkBridgePort,
  launchData: string,
  initial: HostSnapshot,
): MiniAppAdapter {
  let current = initial;
  const snapshot = () => copySnapshot(current);

  return {
    id: "vk",
    launchData,
    capabilities: new Set(CAPABILITIES),
    snapshot,
    subscribe<K extends MiniAppEvent>(
      event: K,
      listener: (payload: MiniAppEventMap[K]) => void,
    ) {
      if (
        event !== "activated" &&
        event !== "deactivated" &&
        event !== "themeChanged" &&
        event !== "viewportChanged" &&
        event !== "safeAreaChanged"
      ) {
        throw new MiniAppError(
          "unsupported",
          `Event subscription is unavailable: ${event}`,
        );
      }

      let active = true;
      const rawListener = (rawEvent: unknown) => {
        if (!active) return;
        const detail = eventDetail(rawEvent);
        if (!detail) return;

        if (detail.type === "VKWebAppViewRestore" && event === "activated") {
          listener(undefined as MiniAppEventMap[K]);
          return;
        }
        if (detail.type === "VKWebAppViewHide" && event === "deactivated") {
          listener(undefined as MiniAppEventMap[K]);
          return;
        }
        if (detail.type === "VKWebAppUpdateInsets") {
          const insets = normalizeInsets(record(detail.data)?.insets);
          if (!insets) return;
          current = { ...current, safeArea: insets };
          if (event === "safeAreaChanged")
            listener({ ...insets } as MiniAppEventMap[K]);
          return;
        }
        if (detail.type !== "VKWebAppUpdateConfig") return;
        const config = normalizeConfig(detail.data);
        if (!config) return;
        current = { ...current, ...config };
        if (event === "themeChanged")
          listener(snapshot() as MiniAppEventMap[K]);
        else if (
          event === "viewportChanged" &&
          config.viewportHeight !== undefined
        ) {
          listener(snapshot() as MiniAppEventMap[K]);
        } else if (event === "safeAreaChanged" && config.safeArea) {
          listener({ ...config.safeArea } as MiniAppEventMap[K]);
        }
      };

      try {
        host.subscribe(rawListener);
      } catch (cause) {
        active = false;
        throw new MiniAppError(
          "failed",
          "VK bridge event subscription failed.",
          { cause },
        );
      }
      return () => {
        if (!active) return;
        active = false;
        try {
          host.unsubscribe(rawListener);
        } catch {
          // Releasing an SDK listener remains best effort.
        }
      };
    },
    async execute<K extends MiniAppOperation>(
      operation: K,
      _input: OperationInput<K>,
      context: RequestContext,
    ): Promise<OperationOutput<K>> {
      if (context.signal?.aborted) throw new MiniAppError("aborted");
      if (operation === "ready") return undefined as OperationOutput<K>;
      throw new MiniAppError("unsupported", `${operation} is unavailable`);
    },
  };
}

/** Initialize VK Bridge and create an adapter with an initial host snapshot. */
export async function createAdapter(
  options: VkAdapterOptions = {},
): Promise<MiniAppAdapter> {
  const host = options.bridge ?? bridge;
  const launchData = options.launchData ?? globalThis.location?.search ?? "";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = validateSignal(options.signal);
  if (typeof launchData !== "string")
    throw new TypeError("launchData must be a string");
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`,
    );
  }
  const deadline = Date.now() + timeoutMs;

  try {
    const initialized = await bounded(
      () => host.send("VKWebAppInit"),
      deadline,
      signal,
    );
    if (record(initialized)?.result !== true) {
      throw new MiniAppError(
        "invalid-response",
        "VK bridge returned an invalid init result.",
      );
    }
    const config = await bounded(
      () => host.send("VKWebAppGetConfig"),
      deadline,
      signal,
    );
    const initial = normalizeConfig(config);
    if (!initial) {
      throw new MiniAppError(
        "invalid-response",
        "VK bridge returned an invalid config result.",
      );
    }
    return makeAdapter(host, launchData, initial);
  } catch (cause) {
    if (cause instanceof MiniAppError) throw cause;
    throw new MiniAppError("failed", "VK bridge initialization failed.", {
      cause,
    });
  }
}

/** Detect the official embedded runtime before initializing it. */
export async function detectAdapter(
  options: VkAdapterOptions = {},
): Promise<MiniAppAdapter | null> {
  const host = options.bridge ?? bridge;
  try {
    if (!host.isEmbedded()) return null;
  } catch {
    return null;
  }
  return createAdapter({ ...options, bridge: host });
}
