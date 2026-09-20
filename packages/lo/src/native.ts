import {
  MINI_APP_LIMITS,
  MINI_APP_PROTOCOL_VERSION,
  MiniAppError,
} from "@lo-ink/miniapp-sdk";
import type {
  AdapterRequest,
  Capability,
  HostSnapshot,
  MiniAppAdapter,
  MiniAppEvent,
  MiniAppEventMap,
  MiniAppOperation,
  OperationInput,
  OperationOutput,
  RequestContext,
  ThemeColors,
} from "@lo-ink/miniapp-sdk";

export interface LoMiniAppNativePort {
  readonly protocolVersion: 1;
  readonly generation: string;
  readonly launchData: string;
  readonly operations: readonly string[];
  readonly capabilities: readonly string[];
  readonly events?: readonly string[];
  readonly canonicalSnapshot?: boolean;
  snapshot(): HostSnapshot;
  postMessage(raw: string): void;
  subscribe(listener: (raw: string) => void): () => void;
}

export type LoNativeGlobal = { LO?: { MiniAppNative?: LoMiniAppNativePort } };

const CHANNEL = "lo.miniapp";
const MAX_PENDING_REQUESTS = 32;
const MAX_REQUEST_LIFETIME_MS = 60_000;
const MAX_GENERATION_LENGTH = 128;
const MAX_LAUNCH_DATA_BYTES = MINI_APP_LIMITS.envelopeBytes;
const MAX_HOST_LIST_ENTRIES = 128;
const MAX_HOST_LIST_ENTRY_BYTES = 64;
const MAX_ERROR_MESSAGE_BYTES = 1_024;
const GENERATION_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const operationCapabilities = {
  ready: "ready",
  close: "close",
  expand: "expand",
  requestFullscreen: "fullscreen",
  exitFullscreen: "fullscreen",
  hideKeyboard: "hideKeyboard",
  setOrientationLock: "orientation",
  setButton: "backButton",
  setClosingConfirmation: "closingConfirmation",
  setHeaderColor: "headerColor",
  setBackgroundColor: "backgroundColor",
  setBottomBarColor: "bottomBarColor",
  haptic: "haptics",
  showPopup: "popup",
  openLink: "openLink",
  sendData: "sendData",
  switchInlineQuery: "switchInlineQuery",
  readClipboard: "clipboard",
  getLocation: "location",
  openLocationSettings: "location",
  getBiometryInfo: "biometry",
  requestBiometryAccess: "biometry",
  authenticateBiometry: "biometry",
  updateBiometryToken: "biometry",
  openBiometrySettings: "biometry",
  startAccelerometer: "sensors",
  stopAccelerometer: "sensors",
  startGyroscope: "sensors",
  stopGyroscope: "sensors",
  startDeviceOrientation: "sensors",
  stopDeviceOrientation: "sensors",
  downloadFile: "downloadFile",
  openQrScanner: "qrScanner",
  closeQrScanner: "qrScanner",
  requestWriteAccess: "requestWriteAccess",
  requestContact: "requestContact",
  shareMessage: "shareMessage",
  cloudStorageSet: "cloudStorage",
  cloudStorageGet: "cloudStorage",
  cloudStorageGetMany: "cloudStorage",
  cloudStorageRemove: "cloudStorage",
  cloudStorageRemoveMany: "cloudStorage",
  cloudStorageKeys: "cloudStorage",
  deviceStorageSet: "deviceStorage",
  deviceStorageGet: "deviceStorage",
  deviceStorageRemove: "deviceStorage",
  deviceStorageClear: "deviceStorage",
  secureStorageSet: "secureStorage",
  secureStorageGet: "secureStorage",
  secureStorageRestore: "secureStorage",
  secureStorageRemove: "secureStorage",
  secureStorageClear: "secureStorage",
} as const satisfies Partial<Record<MiniAppOperation, Capability>>;

export type LoNativeOperation = keyof typeof operationCapabilities;
const nativeOperations = new Set<MiniAppOperation>(
  Object.keys(operationCapabilities) as LoNativeOperation[],
);
const nativeEvents = new Set<MiniAppEvent>([
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
  "accelerometerChanged",
  "accelerometerFailed",
  "gyroscopeChanged",
  "gyroscopeFailed",
  "orientationChanged",
  "orientationFailed",
]);
const voidOperations = new Set<MiniAppOperation>([
  "ready",
  "close",
  "expand",
  "requestFullscreen",
  "exitFullscreen",
  "hideKeyboard",
  "setOrientationLock",
  "setButton",
  "setClosingConfirmation",
  "setHeaderColor",
  "setBackgroundColor",
  "setBottomBarColor",
  "haptic",
  "openLink",
  "sendData",
  "switchInlineQuery",
  "openLocationSettings",
  "openBiometrySettings",
  "openQrScanner",
  "closeQrScanner",
]);

type ValidatedPort = {
  generation: string;
  launchData: string;
  operations: ReadonlySet<string>;
  capabilities: ReadonlySet<string>;
  events: ReadonlySet<string>;
  canonicalSnapshot: boolean;
  initialSnapshot: HostSnapshot;
  snapshot(): unknown;
  postMessage(raw: string): void;
  subscribe(listener: (raw: string) => void): unknown;
};

export interface LoNativeAdapter extends MiniAppAdapter {
  readonly nativeOperations: ReadonlySet<LoNativeOperation>;
  readonly nativeEvents: ReadonlySet<MiniAppEvent>;
  readonly canonicalSnapshot: boolean;
  nativeSupports<K extends MiniAppOperation>(
    operation: K,
    input: OperationInput<K>,
  ): boolean;
}

const eventCapabilities = new Map<MiniAppEvent, Capability>([
  ["fullscreenChanged", "fullscreen"],
  ["fullscreenFailed", "fullscreen"],
  ["backButtonClicked", "backButton"],
  ["mainButtonClicked", "mainButton"],
  ["secondaryButtonClicked", "secondaryButton"],
  ["settingsButtonClicked", "settingsButton"],
  ["qrTextReceived", "qrScanner"],
  ["qrScannerClosed", "qrScanner"],
  ["accelerometerChanged", "sensors"],
  ["accelerometerFailed", "sensors"],
  ["gyroscopeChanged", "sensors"],
  ["gyroscopeFailed", "sensors"],
  ["orientationChanged", "sensors"],
  ["orientationFailed", "sensors"],
]);

type EnvelopeListener = (envelope: Record<string, unknown>) => void;
type PortConnection = {
  subscribeResult(id: string, listener: EnvelopeListener): () => void;
  subscribeEvent(listener: EnvelopeListener): () => void;
};
type PortState = {
  readonly generation: string;
  readonly launchData: string;
  readonly pending: Set<string>;
  readonly connection: PortConnection;
};
const states = new WeakMap<object, PortState>();
let adapterSequence = 0n;
let requestSequence = 0n;
const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function hasValidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedString(
  value: unknown,
  maximumBytes: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    hasValidUnicode(value) &&
    byteLength(value) <= maximumBytes
  );
}

function validGeneration(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= MAX_GENERATION_LENGTH &&
    GENERATION_PATTERN.test(value)
  );
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function stringSet(value: unknown): ReadonlySet<string> | null {
  if (!Array.isArray(value) || value.length > MAX_HOST_LIST_ENTRIES)
    return null;
  const result = new Set<string>();
  for (const entry of value) {
    if (!boundedString(entry, MAX_HOST_LIST_ENTRY_BYTES) || result.has(entry)) {
      return null;
    }
    result.add(entry);
  }
  return result;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNonnegative(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

function normalizeInsets(value: unknown) {
  if (value === undefined) return undefined;
  const source = record(value);
  if (!source) return null;
  const top = finiteNonnegative(source.top);
  const right = finiteNonnegative(source.right);
  const bottom = finiteNonnegative(source.bottom);
  const left = finiteNonnegative(source.left);
  if (
    top === null ||
    top === undefined ||
    right === null ||
    right === undefined ||
    bottom === null ||
    bottom === undefined ||
    left === null ||
    left === undefined
  ) {
    return null;
  }
  return { top, right, bottom, left };
}

const themeKeys = new Set<keyof ThemeColors>([
  "background",
  "text",
  "mutedText",
  "link",
  "action",
  "actionText",
  "secondaryBackground",
  "headerBackground",
  "accentText",
  "sectionBackground",
  "sectionHeaderText",
  "subtitleText",
  "destructiveText",
  "bottomBarBackground",
]);

function normalizeTheme(value: unknown): ThemeColors | undefined | null {
  if (value === undefined) return undefined;
  const source = record(value);
  if (!source) return null;
  const result: ThemeColors = {};
  for (const [key, color] of Object.entries(source)) {
    if (!themeKeys.has(key as keyof ThemeColors)) continue;
    if (!boundedString(color, 256)) return null;
    result[key as keyof ThemeColors] = color;
  }
  return result;
}

function normalizeSnapshot(value: unknown): HostSnapshot | null {
  const source = record(value);
  if (!source) return null;
  const colorScheme = source.colorScheme;
  if (
    colorScheme !== undefined &&
    colorScheme !== "light" &&
    colorScheme !== "dark"
  ) {
    return null;
  }
  const theme = normalizeTheme(source.theme);
  const viewportHeight = finiteNonnegative(source.viewportHeight);
  const stableViewportHeight = finiteNonnegative(source.stableViewportHeight);
  const safeArea = normalizeInsets(source.safeArea);
  const contentSafeArea = normalizeInsets(source.contentSafeArea);
  const isFullscreen = optionalBoolean(source.isFullscreen);
  const isOrientationLocked = optionalBoolean(source.isOrientationLocked);
  if (
    theme === null ||
    viewportHeight === null ||
    stableViewportHeight === null ||
    safeArea === null ||
    contentSafeArea === null ||
    isFullscreen === null ||
    isOrientationLocked === null
  ) {
    return null;
  }
  return {
    ...(colorScheme === undefined ? {} : { colorScheme }),
    ...(theme === undefined ? {} : { theme }),
    ...(viewportHeight === undefined ? {} : { viewportHeight }),
    ...(stableViewportHeight === undefined ? {} : { stableViewportHeight }),
    ...(safeArea === undefined ? {} : { safeArea }),
    ...(contentSafeArea === undefined ? {} : { contentSafeArea }),
    ...(isFullscreen === undefined ? {} : { isFullscreen }),
    ...(isOrientationLocked === undefined ? {} : { isOrientationLocked }),
  };
}

function validatePort(value: unknown): ValidatedPort | null {
  const port = record(value);
  if (!port) return null;
  try {
    if (
      port.protocolVersion !== MINI_APP_PROTOCOL_VERSION ||
      !validGeneration(port.generation) ||
      !boundedString(port.launchData, MAX_LAUNCH_DATA_BYTES) ||
      typeof port.snapshot !== "function" ||
      typeof port.postMessage !== "function" ||
      typeof port.subscribe !== "function"
    ) {
      return null;
    }
    const operations = stringSet(port.operations);
    const capabilities = stringSet(port.capabilities);
    const events =
      port.events === undefined
        ? new Set(["activated", "deactivated"])
        : stringSet(port.events);
    if (!operations || !capabilities || !events) return null;
    const snapshot = port.snapshot.bind(value);
    const initialSnapshot = normalizeSnapshot(snapshot());
    if (!initialSnapshot) return null;
    return {
      generation: port.generation,
      launchData: port.launchData,
      operations,
      capabilities,
      events,
      canonicalSnapshot: port.canonicalSnapshot === true,
      initialSnapshot,
      snapshot,
      postMessage: port.postMessage.bind(value),
      subscribe: port.subscribe.bind(value),
    };
  } catch {
    return null;
  }
}

function parseEnvelope(raw: unknown): Record<string, unknown> | null {
  if (
    !boundedString(raw, MINI_APP_LIMITS.envelopeBytes, true) ||
    raw.length === 0
  ) {
    return null;
  }
  try {
    return record(JSON.parse(raw));
  } catch {
    return null;
  }
}

function envelopeMatches(
  envelope: Record<string, unknown>,
  generation: string,
): boolean {
  return (
    envelope.channel === CHANNEL &&
    envelope.version === MINI_APP_PROTOCOL_VERSION &&
    envelope.generation === generation
  );
}

function hostError(value: unknown): MiniAppError | null {
  const source = record(value);
  if (
    !source ||
    !boundedString(source.code, MAX_HOST_LIST_ENTRY_BYTES) ||
    !boundedString(source.message, MAX_ERROR_MESSAGE_BYTES)
  ) {
    return null;
  }
  const code =
    source.code === "unsupported_operation"
      ? "unsupported"
      : source.code === "timeout"
        ? "timeout"
        : source.code === "invalid_request" ||
            source.code === "busy" ||
            source.code === "host_error"
          ? "failed"
          : null;
  return code ? new MiniAppError(code, source.message) : null;
}

function normalizeEventPayload(
  event: MiniAppEvent,
  value: unknown,
): unknown | null {
  if (
    [
      "activated",
      "deactivated",
      "backButtonClicked",
      "mainButtonClicked",
      "secondaryButtonClicked",
      "settingsButtonClicked",
      "qrScannerClosed",
    ].includes(event)
  ) {
    return value === null || value === undefined ? undefined : null;
  }
  if (["themeChanged", "viewportChanged"].includes(event))
    return normalizeSnapshot(value);
  if (["safeAreaChanged", "contentSafeAreaChanged"].includes(event))
    return normalizeInsets(value);
  if (event === "fullscreenChanged")
    return typeof value === "boolean" ? value : null;
  const source = record(value);
  if (!source) return null;
  if (
    [
      "fullscreenFailed",
      "accelerometerFailed",
      "gyroscopeFailed",
      "orientationFailed",
    ].includes(event)
  ) {
    return source.reason === undefined ||
      boundedString(source.reason, MAX_ERROR_MESSAGE_BYTES, true)
      ? { reason: source.reason as string | undefined }
      : null;
  }
  if (event === "qrTextReceived") {
    return boundedString(source.data, 8192) ? { data: source.data } : null;
  }
  if (["accelerometerChanged", "gyroscopeChanged"].includes(event)) {
    return [source.x, source.y, source.z].every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
      ? { x: source.x, y: source.y, z: source.z }
      : null;
  }
  if (event === "orientationChanged") {
    return typeof source.absolute === "boolean" &&
      [source.alpha, source.beta, source.gamma].every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
      ? {
          absolute: source.absolute,
          alpha: source.alpha,
          beta: source.beta,
          gamma: source.gamma,
        }
      : null;
  }
  return null;
}

function normalizeOperationResult(
  operation: LoNativeOperation,
  value: unknown,
): unknown | null {
  if (voidOperations.has(operation))
    return value === null || value === undefined ? undefined : null;
  if (
    [
      "requestWriteAccess",
      "requestContact",
      "shareMessage",
      "requestBiometryAccess",
      "updateBiometryToken",
      "startAccelerometer",
      "stopAccelerometer",
      "startGyroscope",
      "stopGyroscope",
      "startDeviceOrientation",
      "stopDeviceOrientation",
      "downloadFile",
      "cloudStorageSet",
      "cloudStorageRemove",
      "cloudStorageRemoveMany",
      "deviceStorageSet",
      "deviceStorageRemove",
      "deviceStorageClear",
      "secureStorageSet",
      "secureStorageRemove",
      "secureStorageClear",
    ].includes(operation)
  ) {
    return typeof value === "boolean" ? value : null;
  }
  if (["readClipboard", "deviceStorageGet"].includes(operation))
    return value === null || typeof value === "string" ? value : null;
  if (["cloudStorageGet", "secureStorageRestore"].includes(operation))
    return typeof value === "string" ? value : null;
  if (operation === "showPopup")
    return value === undefined || value === null || typeof value === "string"
      ? (value ?? undefined)
      : null;
  if (operation === "getLocation") {
    if (value === null) return value;
    const source = record(value);
    if (
      !source ||
      typeof source.latitude !== "number" ||
      !Number.isFinite(source.latitude) ||
      Math.abs(source.latitude) > 90 ||
      typeof source.longitude !== "number" ||
      !Number.isFinite(source.longitude) ||
      Math.abs(source.longitude) > 180
    )
      return null;
    for (const key of [
      "altitude",
      "course",
      "speed",
      "horizontalAccuracy",
      "verticalAccuracy",
      "courseAccuracy",
      "speedAccuracy",
    ]) {
      if (
        source[key] !== null &&
        (typeof source[key] !== "number" || !Number.isFinite(source[key]))
      )
        return null;
    }
    return {
      latitude: source.latitude,
      longitude: source.longitude,
      altitude: source.altitude,
      course: source.course,
      speed: source.speed,
      horizontalAccuracy: source.horizontalAccuracy,
      verticalAccuracy: source.verticalAccuracy,
      courseAccuracy: source.courseAccuracy,
      speedAccuracy: source.speedAccuracy,
    };
  }
  if (operation === "getBiometryInfo") {
    const source = record(value);
    return source &&
      typeof source.available === "boolean" &&
      ["finger", "face", "unknown"].includes(String(source.type)) &&
      typeof source.accessRequested === "boolean" &&
      typeof source.accessGranted === "boolean" &&
      typeof source.tokenSaved === "boolean" &&
      boundedString(source.deviceId, 1024, true)
      ? {
          available: source.available,
          type: source.type,
          accessRequested: source.accessRequested,
          accessGranted: source.accessGranted,
          tokenSaved: source.tokenSaved,
          deviceId: source.deviceId,
        }
      : null;
  }
  if (operation === "authenticateBiometry") {
    const source = record(value);
    return source &&
      typeof source.authenticated === "boolean" &&
      (source.token === undefined || boundedString(source.token, 4096, true))
      ? {
          authenticated: source.authenticated,
          ...(source.token === undefined ? {} : { token: source.token }),
        }
      : null;
  }
  if (operation === "cloudStorageGetMany") {
    const source = record(value);
    return source &&
      Object.entries(source).every(
        ([key, item]) => boundedString(key, 128) && typeof item === "string",
      )
      ? Object.fromEntries(Object.entries(source))
      : null;
  }
  if (operation === "cloudStorageKeys")
    return Array.isArray(value) &&
      value.every((item) => typeof item === "string")
      ? value.slice()
      : null;
  if (operation === "secureStorageGet") {
    const source = record(value);
    return source &&
      (source.value === null || typeof source.value === "string") &&
      typeof source.canRestore === "boolean"
      ? { value: source.value, canRestore: source.canRestore }
      : null;
  }
  return null;
}

function releaseOnce(release: (() => void) | undefined): () => void {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    try {
      release?.();
    } catch {
      /* A host cleanup failure cannot reactivate a retained listener. */
    }
  };
}

function createPortConnection(port: ValidatedPort): PortConnection {
  const requests = new Map<string, EnvelopeListener>();
  const events = new Set<EnvelopeListener>();
  let stopPort: (() => void) | undefined;

  const stopWhenIdle = () => {
    if (requests.size || events.size || !stopPort) return;
    const stop = stopPort;
    stopPort = undefined;
    stop();
  };
  const ensurePortSubscription = () => {
    if (stopPort) return;
    let active = true;
    const rawListener = (raw: string) => {
      if (!active) return;
      const envelope = parseEnvelope(raw);
      if (!envelope || !envelopeMatches(envelope, port.generation)) return;
      if (validRequestId(envelope.id)) requests.get(envelope.id)?.(envelope);
      for (const listener of [...events]) {
        try {
          listener(envelope);
        } catch {
          /* One application listener cannot prevent delivery to another. */
        }
      }
    };
    let subscribed: unknown;
    try {
      subscribed = port.subscribe(rawListener);
    } catch (error) {
      active = false;
      throw error;
    }
    if (typeof subscribed !== "function") {
      active = false;
      throw new MiniAppError(
        "invalid-response",
        "LO host returned an invalid subscription",
      );
    }
    stopPort = releaseOnce(() => {
      active = false;
      (subscribed as () => void)();
    });
    stopWhenIdle();
  };
  const add = (
    collection: Map<string, EnvelopeListener> | Set<EnvelopeListener>,
    key: string | EnvelopeListener,
    listener: EnvelopeListener,
  ) => {
    if (collection instanceof Map) collection.set(key as string, listener);
    else collection.add(listener);
    try {
      ensurePortSubscription();
    } catch (error) {
      if (collection instanceof Map) collection.delete(key as string);
      else collection.delete(listener);
      throw error;
    }
    return releaseOnce(() => {
      if (collection instanceof Map) collection.delete(key as string);
      else collection.delete(listener);
      stopWhenIdle();
    });
  };

  return {
    subscribeResult(id, listener) {
      return add(requests, id, listener);
    },
    subscribeEvent(listener) {
      return add(events, listener, listener);
    },
  };
}

function serialize(value: Record<string, unknown>): string {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch (cause) {
    throw new MiniAppError("failed", "LO host request could not be encoded", {
      cause,
    });
  }
  if (
    !hasValidUnicode(raw) ||
    byteLength(raw) > MINI_APP_LIMITS.envelopeBytes
  ) {
    throw new MiniAppError("failed", "LO host request is too large");
  }
  return raw;
}

function request<K extends LoNativeOperation>(
  port: ValidatedPort,
  connection: PortConnection,
  state: PortState,
  adapterId: string,
  operation: K,
  input: OperationInput<K>,
  context: RequestContext,
): AdapterRequest<OperationOutput<K>> {
  const signal = context.signal;
  requestSequence += 1n;
  const id = `r_${adapterId}_${requestSequence.toString(36)}`;
  if (state.pending.size >= MAX_PENDING_REQUESTS) {
    return {
      promise: Promise.reject(
        new MiniAppError("failed", "LO host has too many pending requests"),
      ),
    };
  }
  state.pending.add(id);

  let active = true;
  let cancelling = false;
  let posted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removePortListener = releaseOnce(undefined);
  let removeAbortListener = releaseOnce(undefined);
  let resolveRequest!: (value: OperationOutput<K>) => void;
  let rejectRequest!: (error: unknown) => void;
  const promise = new Promise<OperationOutput<K>>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });

  const finish = (
    outcome:
      | { ok: true; value: OperationOutput<K> }
      | { ok: false; error: unknown },
  ) => {
    if (!active) return;
    active = false;
    state.pending.delete(id);
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener();
    removePortListener();
    if (outcome.ok) resolveRequest(outcome.value);
    else rejectRequest(outcome.error);
  };

  const sendCancel = () => {
    if (!active || !posted) return;
    try {
      port.postMessage(
        serialize({
          channel: CHANNEL,
          version: MINI_APP_PROTOCOL_VERSION,
          generation: port.generation,
          kind: "cancel",
          id,
        }),
      );
    } catch {
      /* Cancellation remains best effort. */
    }
  };
  const cancel = (error: MiniAppError) => {
    if (!active) return;
    cancelling = true;
    sendCancel();
    finish({ ok: false, error });
  };

  if (signal?.aborted) {
    finish({ ok: false, error: new MiniAppError("aborted") });
    return { promise, cleanup: () => {} };
  }

  try {
    const release = connection.subscribeResult(id, (envelope) => {
      if (!active || cancelling) return;
      if (envelope.kind !== "result" || typeof envelope.ok !== "boolean") {
        finish({
          ok: false,
          error: new MiniAppError("invalid-response", "Invalid LO host result"),
        });
        return;
      }
      if (!envelope.ok) {
        if (envelope.value !== undefined) {
          finish({
            ok: false,
            error: new MiniAppError(
              "invalid-response",
              "Invalid LO host result",
            ),
          });
          return;
        }
        const error = hostError(envelope.error);
        finish({
          ok: false,
          error:
            error ??
            new MiniAppError("invalid-response", "Invalid LO host error"),
        });
        return;
      }
      if (envelope.error !== undefined) {
        finish({
          ok: false,
          error: new MiniAppError("invalid-response", "Invalid LO host result"),
        });
      } else {
        const normalized = normalizeOperationResult(operation, envelope.value);
        const nullable =
          operation === "readClipboard" ||
          operation === "getLocation" ||
          operation === "deviceStorageGet";
        if (normalized === null && !(nullable && envelope.value === null)) {
          finish({
            ok: false,
            error: new MiniAppError(
              "invalid-response",
              "Invalid LO host result",
            ),
          });
        } else {
          finish({ ok: true, value: normalized as OperationOutput<K> });
        }
      }
    });
    removePortListener = releaseOnce(release);
    if (!active) {
      removePortListener();
      return { promise, cleanup: () => {} };
    }
  } catch (error) {
    finish({ ok: false, error });
    return { promise, cleanup: () => {} };
  }

  const abort = () => cancel(new MiniAppError("aborted"));
  try {
    signal?.addEventListener("abort", abort, { once: true });
    removeAbortListener = releaseOnce(() =>
      signal?.removeEventListener("abort", abort),
    );
    if (signal?.aborted) {
      abort();
      return { promise, cleanup: () => {} };
    }
  } catch (error) {
    finish({ ok: false, error });
    return { promise, cleanup: () => {} };
  }

  try {
    timer = setTimeout(
      () => cancel(new MiniAppError("timeout")),
      MAX_REQUEST_LIFETIME_MS,
    );
  } catch (error) {
    finish({ ok: false, error });
    return { promise, cleanup: () => {} };
  }

  try {
    const envelope: Record<string, unknown> = {
      channel: CHANNEL,
      version: MINI_APP_PROTOCOL_VERSION,
      generation: port.generation,
      kind: "request",
      id,
      operation,
    };
    if (input !== undefined) envelope.input = input;
    const raw = serialize(envelope);
    posted = true;
    port.postMessage(raw);
  } catch (error) {
    posted = false;
    finish({ ok: false, error });
  }

  return {
    promise,
    cleanup: () => {
      if (active) cancel(new MiniAppError("aborted"));
    },
  };
}

/** Discovers the canonical LO native port without loading code or authenticating launch data. */
export function createNativeAdapter(
  scope: LoNativeGlobal = globalThis as LoNativeGlobal,
): LoNativeAdapter | null {
  let value: unknown;
  try {
    value = scope.LO?.MiniAppNative;
  } catch {
    return null;
  }
  const port = validatePort(value);
  if (!port || value === null || typeof value !== "object") return null;
  let state = states.get(value);
  if (
    state &&
    (state.generation !== port.generation ||
      state.launchData !== port.launchData)
  ) {
    return null;
  }
  if (!state) {
    state = {
      generation: port.generation,
      launchData: port.launchData,
      pending: new Set(),
      connection: createPortConnection(port),
    };
    states.set(value, state);
  }
  adapterSequence += 1n;
  const adapterId = adapterSequence.toString(36);
  const connection = state.connection;
  const supportedOperations = new Set<LoNativeOperation>();
  const capabilities = new Set<Capability>();
  for (const operation of nativeOperations) {
    const typed = operation as LoNativeOperation;
    const capability = operationCapabilities[typed];
    if (typed === "setButton" && port.operations.has(operation)) {
      const buttonCapabilities = [
        "backButton",
        "mainButton",
        "secondaryButton",
        "settingsButton",
      ] as const;
      for (const buttonCapability of buttonCapabilities) {
        if (port.capabilities.has(buttonCapability))
          capabilities.add(buttonCapability);
      }
      if (buttonCapabilities.some((value) => capabilities.has(value)))
        supportedOperations.add(typed);
    } else if (
      port.operations.has(operation) &&
      port.capabilities.has(capability)
    ) {
      supportedOperations.add(typed);
      capabilities.add(capability);
    }
  }
  let currentSnapshot = port.initialSnapshot;
  const supportedEvents = new Set<MiniAppEvent>();
  for (const event of nativeEvents) {
    const capability = eventCapabilities.get(event);
    if (
      port.events.has(event) &&
      (!capability || port.capabilities.has(capability))
    )
      supportedEvents.add(event);
  }

  return {
    id: "lo",
    launchData: port.launchData,
    capabilities,
    nativeOperations: supportedOperations,
    nativeEvents: supportedEvents,
    canonicalSnapshot: port.canonicalSnapshot,
    nativeSupports(operation, input) {
      if (!supportedOperations.has(operation as LoNativeOperation))
        return false;
      if (operation !== "setButton") return true;
      const button = (input as OperationInput<"setButton">).button;
      return capabilities.has(`${button}Button` as Capability);
    },
    snapshot() {
      try {
        const next = normalizeSnapshot(port.snapshot());
        if (next) currentSnapshot = next;
      } catch {
        /* Preserve the last validated host snapshot. */
      }
      return currentSnapshot;
    },
    subscribe<K extends MiniAppEvent>(
      event: K,
      listener: (payload: MiniAppEventMap[K]) => void,
    ) {
      if (!supportedEvents.has(event)) {
        throw new MiniAppError(
          "unsupported",
          `Event subscription is unavailable: ${event}`,
        );
      }
      let active = true;
      const rawListener = (envelope: Record<string, unknown>) => {
        if (!active) return;
        if (envelope.kind !== "event" || envelope.event !== event) return;
        const payload = normalizeEventPayload(event, envelope.payload);
        if (payload === null) return;
        listener(payload as MiniAppEventMap[K]);
      };
      let release: (() => void) | undefined;
      try {
        release = connection.subscribeEvent(rawListener);
      } catch (error) {
        active = false;
        throw error;
      }
      const stop = releaseOnce(release);
      return () => {
        if (!active) return;
        active = false;
        stop();
      };
    },
    execute<K extends MiniAppOperation>(
      operation: K,
      input: OperationInput<K>,
      context: RequestContext,
    ) {
      if (!supportedOperations.has(operation as LoNativeOperation)) {
        return Promise.reject(
          new MiniAppError("unsupported", `${operation} is unavailable`),
        );
      }
      if (operation === "setButton") {
        const button = (input as OperationInput<"setButton">).button;
        const buttonCapability = `${button}Button` as Capability;
        if (!capabilities.has(buttonCapability)) {
          return Promise.reject(
            new MiniAppError(
              "unsupported",
              `${buttonCapability} is unavailable`,
            ),
          );
        }
      }
      return request(
        port,
        connection,
        state,
        adapterId,
        operation as LoNativeOperation,
        input as OperationInput<LoNativeOperation>,
        context,
      ) as AdapterRequest<OperationOutput<K>>;
    },
  };
}
