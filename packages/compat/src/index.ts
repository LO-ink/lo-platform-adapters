import { MINI_APP_CAPABILITIES, MiniAppError } from "@lo-ink/miniapp-sdk";
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

export type LegacyWebApp = Record<string, unknown> & {
  initData?: string;
  capabilities?: readonly string[];
  version?: string;
  onEvent?: (event: string, listener: (...args: unknown[]) => void) => void;
  offEvent?: (event: string, listener: (...args: unknown[]) => void) => void;
};

type Request<T> = AdapterRequest<T> | PromiseLike<T>;
const unsupported = (operation: string) =>
  Promise.reject(
    new MiniAppError("unsupported", `${operation} is unavailable`),
  );
const resolved = <T>(value: T): Promise<T> => Promise.resolve(value);
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
const method = (target: unknown, name: string) =>
  typeof record(target)?.[name] === "function";
function invoke(target: unknown, name: string, ...args: unknown[]): unknown {
  const fn = record(target)?.[name];
  if (typeof fn !== "function")
    throw new MiniAppError("unsupported", `${name} is unavailable`);
  return Reflect.apply(fn, target, args);
}
const invalid = (message: string) =>
  new MiniAppError("invalid-response", message);

function callback<T>(
  start: (done: (...values: unknown[]) => void) => void,
  map: (...values: unknown[]) => T,
): AdapterRequest<T> {
  let active = true;
  return {
    promise: new Promise<T>((resolve, reject) => {
      try {
        start((...values) => {
          if (!active) return;
          try {
            resolve(map(...values));
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    }),
    cleanup: () => {
      active = false;
    },
  };
}

function storageCallback<T>(
  start: (
    done: (error: unknown, value?: unknown, extra?: unknown) => void,
  ) => void,
  map: (value: unknown, extra: unknown) => T,
): AdapterRequest<T> {
  let active = true;
  return {
    promise: new Promise<T>((resolve, reject) => {
      try {
        start((error, value, extra) => {
          if (!active) return;
          if (error != null) reject(error);
          else {
            try {
              resolve(map(value, extra));
            } catch (cause) {
              reject(cause);
            }
          }
        });
      } catch (error) {
        reject(error);
      }
    }),
    cleanup: () => {
      active = false;
    },
  };
}

const eventNames: Record<MiniAppEvent, string> = {
  activated: "activated",
  deactivated: "deactivated",
  themeChanged: "themeChanged",
  viewportChanged: "viewportChanged",
  safeAreaChanged: "safeAreaChanged",
  contentSafeAreaChanged: "contentSafeAreaChanged",
  fullscreenChanged: "fullscreenChanged",
  fullscreenFailed: "fullscreenFailed",
  backButtonClicked: "backButtonClicked",
  mainButtonClicked: "mainButtonClicked",
  secondaryButtonClicked: "secondaryButtonClicked",
  settingsButtonClicked: "settingsButtonClicked",
  qrTextReceived: "qrTextReceived",
  qrScannerClosed: "scanQrPopupClosed",
  accelerometerChanged: "accelerometerChanged",
  accelerometerFailed: "accelerometerFailed",
  gyroscopeChanged: "gyroscopeChanged",
  gyroscopeFailed: "gyroscopeFailed",
  orientationChanged: "deviceOrientationChanged",
  orientationFailed: "deviceOrientationFailed",
};

export function webAppCapabilities(
  webApp: LegacyWebApp,
): ReadonlySet<Capability> {
  const known = new Set<string>(MINI_APP_CAPABILITIES);
  return new Set(
    (webApp.capabilities ?? []).filter(
      (value): value is Capability =>
        typeof value === "string" &&
        known.has(value) &&
        (value !== "verticalSwipes" ||
          (method(webApp, "enableVerticalSwipes") &&
            method(webApp, "disableVerticalSwipes"))),
    ),
  );
}

export function createWebAppAdapter(
  id: string,
  webApp: LegacyWebApp,
  capabilities: ReadonlySet<Capability>,
  options: { contentSafeAreaIncludesSystem?: boolean } = {},
): MiniAppAdapter {
  const contentSafeArea = () => {
    const content = normalizeInsets(webApp.contentSafeAreaInset);
    if (!content || !options.contentSafeAreaIncludesSystem) return content;
    const safe = normalizeInsets(webApp.safeAreaInset);
    return {
      top: Math.max(0, content.top - (safe?.top ?? 0)),
      right: Math.max(0, content.right - (safe?.right ?? 0)),
      bottom: Math.max(0, content.bottom - (safe?.bottom ?? 0)),
      left: Math.max(0, content.left - (safe?.left ?? 0)),
    };
  };
  const snapshot = (): HostSnapshot => ({
    colorScheme:
      webApp.colorScheme === "dark"
        ? "dark"
        : webApp.colorScheme === "light"
          ? "light"
          : undefined,
    theme: normalizeTheme(webApp.themeParams),
    viewportHeight:
      typeof webApp.viewportHeight === "number"
        ? webApp.viewportHeight
        : undefined,
    stableViewportHeight:
      typeof webApp.viewportStableHeight === "number"
        ? webApp.viewportStableHeight
        : undefined,
    safeArea: normalizeInsets(webApp.safeAreaInset),
    contentSafeArea: contentSafeArea(),
    isFullscreen:
      typeof webApp.isFullscreen === "boolean"
        ? webApp.isFullscreen
        : undefined,
    isOrientationLocked:
      typeof webApp.isOrientationLocked === "boolean"
        ? webApp.isOrientationLocked
        : undefined,
  });

  return {
    id,
    launchData: typeof webApp.initData === "string" ? webApp.initData : "",
    capabilities,
    snapshot,
    subscribe<K extends MiniAppEvent>(
      event: K,
      listener: (payload: MiniAppEventMap[K]) => void,
    ) {
      if (!webApp.onEvent || !webApp.offEvent) {
        throw new MiniAppError(
          "unsupported",
          `Event subscription is unavailable: ${event}`,
        );
      }
      let active = true;
      const rawListener = (...args: unknown[]) => {
        if (!active) return;
        const first = args[0];
        const fields = record(first);
        let payload: unknown = first;
        if (event === "themeChanged" || event === "viewportChanged")
          payload = snapshot();
        else if (event === "safeAreaChanged")
          payload = normalizeInsets(webApp.safeAreaInset);
        else if (event === "contentSafeAreaChanged")
          payload = contentSafeArea();
        else if (event === "fullscreenChanged")
          payload = webApp.isFullscreen === true;
        else if (
          event === "fullscreenFailed" ||
          event === "accelerometerFailed" ||
          event === "gyroscopeFailed" ||
          event === "orientationFailed"
        )
          payload = {
            reason:
              typeof fields?.error === "string" ? fields.error : undefined,
          };
        else if (event === "accelerometerChanged")
          payload = normalizeVector(webApp.Accelerometer);
        else if (event === "gyroscopeChanged")
          payload = normalizeVector(webApp.Gyroscope);
        else if (event === "orientationChanged")
          payload = normalizeOrientation(webApp.DeviceOrientation);
        else if (event === "qrTextReceived")
          payload =
            typeof first === "string"
              ? { data: first }
              : typeof fields?.data === "string"
                ? { data: fields.data }
                : unavailable;
        if (
          payload === unavailable ||
          ((event === "safeAreaChanged" ||
            event === "contentSafeAreaChanged") &&
            !payload)
        )
          return;
        listener(payload as MiniAppEventMap[K]);
      };
      // Absolute host content insets depend on both legacy values. Recalculate
      // after either event, including hosts that emit the two changes separately.
      const names =
        event === "contentSafeAreaChanged" &&
        options.contentSafeAreaIncludesSystem
          ? [eventNames[event], eventNames.safeAreaChanged]
          : [eventNames[event]];
      const removeListeners = (suppressErrors = false) => {
        const failures: unknown[] = [];
        for (const name of names) {
          try {
            webApp.offEvent?.(name, rawListener);
          } catch (error) {
            failures.push(error);
          }
        }
        if (!suppressErrors && failures.length) throw failures[0];
      };
      try {
        for (const name of names) webApp.onEvent(name, rawListener);
      } catch (error) {
        active = false;
        // Preserve the registration error after attempting every removal.
        // A host retaining any failed removal still cannot notify this listener.
        removeListeners(true);
        throw error;
      }
      return () => {
        if (!active) return;
        active = false;
        removeListeners();
      };
    },
    execute<K extends MiniAppOperation>(
      operation: K,
      input: OperationInput<K>,
      context: RequestContext,
    ): Request<OperationOutput<K>> {
      return execute(
        webApp,
        { operation, input } as OperationRequest,
        context,
      ) as Request<OperationOutput<K>>;
    },
  };
}

function normalizeInsets(input: unknown) {
  const value = record(input);
  if (!value || typeof value !== "object") return undefined;
  const number = (entry: unknown) =>
    typeof entry === "number" && Number.isFinite(entry) ? entry : 0;
  return {
    top: number(value.top),
    right: number(value.right),
    bottom: number(value.bottom),
    left: number(value.left),
  };
}

const unavailable = Symbol("unavailable");
function normalizeTheme(input: unknown): ThemeColors | undefined {
  const value = record(input);
  if (!value || typeof value !== "object") return undefined;
  const mappings: ReadonlyArray<readonly [string, keyof ThemeColors]> = [
    ["bg_color", "background"],
    ["text_color", "text"],
    ["hint_color", "mutedText"],
    ["link_color", "link"],
    ["button_color", "action"],
    ["button_text_color", "actionText"],
    ["secondary_bg_color", "secondaryBackground"],
    ["header_bg_color", "headerBackground"],
    ["accent_text_color", "accentText"],
    ["section_bg_color", "sectionBackground"],
    ["section_header_text_color", "sectionHeaderText"],
    ["subtitle_text_color", "subtitleText"],
    ["destructive_text_color", "destructiveText"],
    ["bottom_bar_bg_color", "bottomBarBackground"],
  ];
  const result: ThemeColors = {};
  for (const [wire, semantic] of mappings) {
    if (typeof value[wire] === "string")
      result[semantic] = value[wire] as string;
  }
  return result;
}
function normalizeVector(input: unknown) {
  const manager = record(input);
  if (
    !manager ||
    typeof manager.x !== "number" ||
    typeof manager.y !== "number" ||
    typeof manager.z !== "number"
  )
    return unavailable;
  return { x: manager.x, y: manager.y, z: manager.z };
}
function normalizeOrientation(input: unknown) {
  const manager = record(input);
  if (
    !manager ||
    typeof manager.absolute !== "boolean" ||
    typeof manager.alpha !== "number" ||
    typeof manager.beta !== "number" ||
    typeof manager.gamma !== "number"
  )
    return unavailable;
  return {
    absolute: manager.absolute,
    alpha: manager.alpha,
    beta: manager.beta,
    gamma: manager.gamma,
  };
}

type OperationRequest = {
  [K in MiniAppOperation]: { operation: K; input: OperationInput<K> };
}[MiniAppOperation];

function execute(
  webApp: LegacyWebApp,
  request: OperationRequest,
  context: RequestContext,
): Request<unknown> {
  const { operation, input } = request;
  switch (operation) {
    case "close":
      return command(webApp, "close");
    case "ready":
      return command(webApp, "ready");
    case "expand":
      return command(webApp, "expand");
    case "requestFullscreen":
      return command(webApp, "requestFullscreen");
    case "exitFullscreen":
      return command(webApp, "exitFullscreen");
    case "hideKeyboard":
      return command(webApp, "hideKeyboard");
    case "setOrientationLock":
      return command(
        webApp,
        input.locked ? "lockOrientation" : "unlockOrientation",
      );
    case "setVerticalSwipes":
      return command(
        webApp,
        input.enabled ? "enableVerticalSwipes" : "disableVerticalSwipes",
      );
    case "setClosingConfirmation":
      return command(
        webApp,
        input.enabled
          ? "enableClosingConfirmation"
          : "disableClosingConfirmation",
      );
    case "setHeaderColor":
      return command(webApp, "setHeaderColor", input.color);
    case "setBackgroundColor":
      return command(webApp, "setBackgroundColor", input.color);
    case "setBottomBarColor":
      return command(webApp, "setBottomBarColor", input.color);
    case "setButton": {
      const buttons: Record<string, unknown> = {
        back: webApp.BackButton,
        main: webApp.MainButton,
        secondary: webApp.SecondaryButton,
        settings: webApp.SettingsButton,
      };
      const button = buttons[input.button];
      if (!button) return unsupported(operation);
      const params = input.params;
      if (input.button === "main" || input.button === "secondary") {
        if (!method(button, "setParams")) return unsupported(operation);
        if (input.button === "main" && params.position !== undefined)
          return unsupported(operation);
        const progress = params.progressVisible;
        const progressMethod = progress ? "showProgress" : "hideProgress";
        if (progress !== undefined && !method(button, progressMethod))
          return unsupported(operation);
        if (progress !== undefined) {
          if (progress) invoke(button, "showProgress", params.active === true);
          else invoke(button, "hideProgress");
        }
        invoke(button, "setParams", {
          text: params.text,
          is_active: params.active,
          is_visible: params.visible,
          color: params.color,
          text_color: params.textColor,
          has_shine_effect: params.shine,
          position: params.position,
        });
      } else {
        if (
          Object.entries(params).some(
            ([key, value]) => key !== "visible" && value !== undefined,
          )
        )
          return unsupported(operation);
        if (params.visible !== undefined) {
          const name = params.visible ? "show" : "hide";
          if (!method(button, name)) return unsupported(operation);
          invoke(button, name);
        }
      }
      return resolved(undefined);
    }
    case "haptic": {
      if (input.kind === "selection") {
        if (!method(webApp.HapticFeedback, "selectionChanged"))
          return unsupported(operation);
        invoke(webApp.HapticFeedback, "selectionChanged");
        return resolved(undefined);
      }
      const notification = ["success", "warning", "error"].includes(input.kind);
      const name = notification ? "notificationOccurred" : "impactOccurred";
      if (!method(webApp.HapticFeedback, name)) return unsupported(operation);
      invoke(webApp.HapticFeedback, name, input.kind);
      return resolved(undefined);
    }
    case "showPopup":
      if (!method(webApp, "showPopup")) return unsupported(operation);
      return callback(
        (done) =>
          invoke(
            webApp,
            "showPopup",
            {
              title: input.title,
              message: input.message,
              buttons: input.buttons?.map((button) => ({
                id: button.id,
                text: button.text,
                type: button.kind,
              })),
            },
            done,
          ),
        (buttonId) => (typeof buttonId === "string" ? buttonId : undefined),
      );
    case "openLink":
      return command(webApp, "openLink", input.url, {
        try_instant_view: input.instantView,
        try_browser: input.externalBrowser,
      });
    case "sendData":
      return command(webApp, "sendData", input.data);
    case "switchInlineQuery":
      return command(webApp, "switchInlineQuery", input.query, input.chatTypes);
    case "readClipboard":
      if (!method(webApp, "readTextFromClipboard"))
        return unsupported(operation);
      return callback(
        (done) => invoke(webApp, "readTextFromClipboard", done),
        (text) => (typeof text === "string" ? text : null),
      );
    case "getLocation": {
      const manager = record(webApp.LocationManager);
      if (!method(manager, "getLocation")) return unsupported(operation);
      return callback((done) => {
        const get = () => {
          if (!context.signal?.aborted) invoke(manager, "getLocation", done);
        };
        if (manager?.isInited || !method(manager, "init")) get();
        else invoke(manager, "init", get);
      }, normalizeLocation);
    }
    case "openLocationSettings":
      return command(webApp.LocationManager, "openSettings");
    case "getBiometryInfo": {
      const manager = record(webApp.BiometricManager);
      if (!manager) return unsupported(operation);
      return callback(
        (done) =>
          manager?.isInited || !method(manager, "init")
            ? done()
            : invoke(manager, "init", done),
        () => ({
          available: manager.isBiometricAvailable === true,
          type:
            manager.biometricType === "finger" ||
            manager.biometricType === "face"
              ? manager.biometricType
              : "unknown",
          accessRequested: manager.isAccessRequested === true,
          accessGranted: manager.isAccessGranted === true,
          tokenSaved: manager.isBiometricTokenSaved === true,
          deviceId:
            typeof manager.deviceId === "string" ? manager.deviceId : "",
        }),
      );
    }
    case "requestBiometryAccess":
      return managerBoolean(webApp.BiometricManager, "requestAccess", {
        reason: input.reason,
      });
    case "authenticateBiometry": {
      const manager = record(webApp.BiometricManager);
      if (!method(manager, "authenticate")) return unsupported(operation);
      return callback(
        (done) =>
          invoke(manager, "authenticate", { reason: input.reason }, done),
        (authenticated, token) => ({
          authenticated: authenticated === true,
          ...(typeof token === "string" ? { token } : {}),
        }),
      );
    }
    case "updateBiometryToken":
      return managerBoolean(
        webApp.BiometricManager,
        "updateBiometricToken",
        input.token,
      );
    case "openBiometrySettings":
      return command(webApp.BiometricManager, "openSettings");
    case "startAccelerometer":
      return sensorStart(
        webApp.Accelerometer,
        { refresh_rate: input.refreshRate },
        context,
      );
    case "stopAccelerometer":
      return managerBoolean(webApp.Accelerometer, "stop");
    case "startGyroscope":
      return sensorStart(
        webApp.Gyroscope,
        { refresh_rate: input.refreshRate },
        context,
      );
    case "stopGyroscope":
      return managerBoolean(webApp.Gyroscope, "stop");
    case "startDeviceOrientation":
      return sensorStart(
        webApp.DeviceOrientation,
        { refresh_rate: input.refreshRate, need_absolute: input.absolute },
        context,
      );
    case "stopDeviceOrientation":
      return managerBoolean(webApp.DeviceOrientation, "stop");
    case "downloadFile":
      if (!method(webApp, "downloadFile")) return unsupported(operation);
      return callback(
        (done) =>
          invoke(
            webApp,
            "downloadFile",
            { url: input.url, file_name: input.fileName },
            done,
          ),
        strictBoolean,
      );
    case "openQrScanner":
      return command(webApp, "showScanQrPopup", { text: input.text });
    case "closeQrScanner":
      return command(webApp, "closeScanQrPopup");
    case "requestWriteAccess":
      return booleanCallback(webApp, "requestWriteAccess");
    case "requestContact":
      return booleanCallback(webApp, "requestContact");
    case "shareMessage":
      return booleanCallback(webApp, "shareMessage", input.id);
    case "shareToStory":
      return command(
        webApp,
        "shareToStory",
        input.mediaUrl,
        input.params
          ? {
              text: input.params.text,
              widget_link: input.params.link
                ? { url: input.params.link.url, name: input.params.link.name }
                : undefined,
            }
          : undefined,
      );
    case "openInvoice":
      if (!method(webApp, "openInvoice")) return unsupported(operation);
      return callback(
        (done) => invoke(webApp, "openInvoice", input.url, done),
        (status) => {
          if (
            status !== "paid" &&
            status !== "cancelled" &&
            status !== "failed" &&
            status !== "pending"
          ) {
            throw new MiniAppError(
              "invalid-response",
              "Invalid invoice status",
            );
          }
          return status;
        },
      );
    case "cloudStorageSet":
      return storage(
        webApp.CloudStorage,
        "setItem",
        [input.key, input.value],
        strictBoolean,
      );
    case "cloudStorageGet":
      return storage(webApp.CloudStorage, "getItem", [input.key], (value) => {
        if (typeof value !== "string")
          throw new MiniAppError(
            "invalid-response",
            "Missing cloud storage value",
          );
        return value;
      });
    case "cloudStorageGetMany":
      return storage(
        webApp.CloudStorage,
        "getItems",
        [[...input.keys]],
        strictStringRecord,
      );
    case "cloudStorageRemove":
      return storage(
        webApp.CloudStorage,
        "removeItem",
        [input.key],
        strictBoolean,
      );
    case "cloudStorageRemoveMany":
      return storage(
        webApp.CloudStorage,
        "removeItems",
        [[...input.keys]],
        strictBoolean,
      );
    case "cloudStorageKeys":
      return storage(webApp.CloudStorage, "getKeys", [], strictStringArray);
    case "deviceStorageSet":
      return storage(
        webApp.DeviceStorage,
        "setItem",
        [input.key, input.value],
        strictBoolean,
      );
    case "deviceStorageGet":
      return storage(
        webApp.DeviceStorage,
        "getItem",
        [input.key],
        strictOptionalString,
      );
    case "deviceStorageRemove":
      return storage(
        webApp.DeviceStorage,
        "removeItem",
        [input.key],
        strictBoolean,
      );
    case "deviceStorageClear":
      return storage(webApp.DeviceStorage, "clear", [], strictBoolean);
    case "secureStorageSet":
      return storage(
        webApp.SecureStorage,
        "setItem",
        [input.key, input.value],
        strictBoolean,
      );
    case "secureStorageGet":
      if (!method(webApp.SecureStorage, "getItem"))
        return unsupported(operation);
      return storageCallback(
        (done) => invoke(webApp.SecureStorage, "getItem", input.key, done),
        (value, canRestore) => ({
          value: strictOptionalString(value),
          canRestore:
            canRestore === undefined ? false : strictBoolean(canRestore),
        }),
      );
    case "secureStorageRestore":
      return storage(
        webApp.SecureStorage,
        "restoreItem",
        [input.key],
        (value) => {
          if (typeof value !== "string")
            throw new MiniAppError(
              "invalid-response",
              "Missing restored value",
            );
          return value;
        },
      );
    case "secureStorageRemove":
      return storage(
        webApp.SecureStorage,
        "removeItem",
        [input.key],
        strictBoolean,
      );
    case "secureStorageClear":
      return storage(webApp.SecureStorage, "clear", [], strictBoolean);
  }
}

function command(
  target: unknown,
  name: string,
  ...args: unknown[]
): Promise<void> {
  if (!method(target, name)) return unsupported(name);
  invoke(target, name, ...args);
  return resolved(undefined);
}
function booleanCallback(target: unknown, name: string, ...args: unknown[]) {
  if (!method(target, name)) return unsupported(name);
  return callback((done) => invoke(target, name, ...args, done), strictBoolean);
}
const sensorOwners = new WeakMap<object, symbol>();
const pendingSensors = new WeakSet<object>();

function sensorStart(
  target: unknown,
  params: unknown,
  context: RequestContext,
): Request<boolean> {
  if (!method(target, "start") || !method(target, "stop"))
    return unsupported("sensor start");
  // A caller must not acquire or later stop a sensor already owned elsewhere.
  if (
    record(target)?.isStarted === true ||
    pendingSensors.has(target as object)
  )
    return resolved(false);
  const owner = Symbol();
  sensorOwners.set(target as object, owner);
  pendingSensors.add(target as object);
  let completed = false;
  let cancelled = false;
  let released = false;
  const stopOwned = () => {
    if (sensorOwners.get(target as object) !== owner) return;
    try {
      invoke(target, "stop");
    } catch {
      /* Cleanup must not replace the request result. */
    }
  };
  return {
    promise: new Promise<boolean>((resolve, reject) => {
      try {
        invoke(target, "start", params, (value: unknown) => {
          if (cancelled) {
            if (value === true) stopOwned();
            return;
          }
          if (completed) return;
          try {
            const started = strictBoolean(value);
            completed = true;
            resolve(started);
          } catch (error) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    }),
    cleanup() {
      if (released) return;
      released = true;
      // Release acquisition exclusivity while retaining the late-callback owner.
      if (sensorOwners.get(target as object) === owner)
        pendingSensors.delete(target as object);
      if (!completed || context.signal?.aborted) {
        cancelled = true;
        stopOwned();
      }
    },
  };
}

function managerBoolean(target: unknown, name: string, params?: unknown) {
  if (!method(target, name)) return unsupported(name);
  return callback(
    (done) =>
      params === undefined
        ? invoke(target, name, done)
        : invoke(target, name, params, done),
    strictBoolean,
  );
}
function storage<T>(
  target: unknown,
  name: string,
  args: unknown[],
  map: (value: unknown) => T,
) {
  if (!method(target, name)) return unsupported(name);
  return storageCallback(
    (done) => invoke(target, name, ...args, done),
    (value) => map(value),
  );
}
function normalizeLocation(input: unknown) {
  const value = record(input);
  if (!value || typeof value !== "object") return null;
  const nullable = (entry: unknown) =>
    typeof entry === "number" ? entry : null;
  if (typeof value.latitude !== "number" || typeof value.longitude !== "number")
    return null;
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    altitude: nullable(value.altitude),
    course: nullable(value.course),
    speed: nullable(value.speed),
    horizontalAccuracy: nullable(value.horizontal_accuracy),
    verticalAccuracy: nullable(value.vertical_accuracy),
    courseAccuracy: nullable(value.course_accuracy),
    speedAccuracy: nullable(value.speed_accuracy),
  };
}

function strictBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalid("Expected a boolean response");
  return value;
}
function strictOptionalString(value: unknown): string | null {
  if (typeof value === "string" || value === null) return value;
  throw invalid("Expected a string or null response");
}
function strictStringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw invalid("Expected a string array response");
  }
  return [...value];
}
function strictStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("Expected a string record response");
  }
  const result: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry !== "string")
      throw invalid("Expected string record values");
    Object.defineProperty(result, key, {
      value: entry,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}
