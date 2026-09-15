import { MINI_APP_CAPABILITIES, MiniAppError } from "@lo/miniapp-sdk";
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
} from "@lo/miniapp-sdk";

export type LegacyWebApp = Record<string, any> & {
  initData?: string;
  capabilities?: readonly string[];
  version?: string;
  onEvent?: (event: string, listener: (...args: any[]) => void) => void;
  offEvent?: (event: string, listener: (...args: any[]) => void) => void;
};

type Request<T> = AdapterRequest<T> | PromiseLike<T>;
const unsupported = (operation: string) =>
  Promise.reject(
    new MiniAppError("unsupported", `${operation} is unavailable`),
  );
const resolved = <T>(value: T): Promise<T> => Promise.resolve(value);
const method = (target: any, name: string) =>
  typeof target?.[name] === "function";
const invalid = (message: string) =>
  new MiniAppError("invalid-response", message);

function callback<T>(
  start: (done: (...values: any[]) => void) => void,
  map: (...values: any[]) => T,
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
  start: (done: (error: unknown, value?: any, extra?: any) => void) => void,
  map: (value: any, extra: any) => T,
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
        typeof value === "string" && known.has(value),
    ),
  );
}

export function createWebAppAdapter(
  id: string,
  webApp: LegacyWebApp,
  capabilities: ReadonlySet<Capability>,
): MiniAppAdapter {
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
    contentSafeArea: normalizeInsets(webApp.contentSafeAreaInset),
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
      const rawListener = (...args: any[]) => {
        if (!active) return;
        const first = args[0];
        let payload: unknown = first;
        if (event === "themeChanged" || event === "viewportChanged")
          payload = snapshot();
        else if (event === "safeAreaChanged")
          payload = normalizeInsets(webApp.safeAreaInset);
        else if (event === "contentSafeAreaChanged")
          payload = normalizeInsets(webApp.contentSafeAreaInset);
        else if (event === "fullscreenChanged")
          payload = webApp.isFullscreen === true;
        else if (
          event === "fullscreenFailed" ||
          event === "accelerometerFailed" ||
          event === "gyroscopeFailed" ||
          event === "orientationFailed"
        )
          payload = {
            reason: typeof first?.error === "string" ? first.error : undefined,
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
              : typeof first?.data === "string"
                ? { data: first.data }
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
      webApp.onEvent(eventNames[event], rawListener);
      return () => {
        if (!active) return;
        active = false;
        webApp.offEvent?.(eventNames[event], rawListener);
      };
    },
    execute<K extends MiniAppOperation>(
      operation: K,
      input: OperationInput<K>,
      context: RequestContext,
    ): Request<OperationOutput<K>> {
      return execute(webApp, operation, input, context) as Request<
        OperationOutput<K>
      >;
    },
  };
}

function normalizeInsets(value: any) {
  if (!value || typeof value !== "object") return undefined;
  const number = (entry: any) =>
    typeof entry === "number" && Number.isFinite(entry) ? entry : 0;
  return {
    top: number(value.top),
    right: number(value.right),
    bottom: number(value.bottom),
    left: number(value.left),
  };
}

const unavailable = Symbol("unavailable");
function normalizeTheme(value: any): ThemeColors | undefined {
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
    if (typeof value[wire] === "string") result[semantic] = value[wire];
  }
  return result;
}
function normalizeVector(manager: any) {
  if (
    !manager ||
    typeof manager.x !== "number" ||
    typeof manager.y !== "number" ||
    typeof manager.z !== "number"
  )
    return unavailable;
  return { x: manager.x, y: manager.y, z: manager.z };
}
function normalizeOrientation(manager: any) {
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

function execute(
  webApp: LegacyWebApp,
  operation: MiniAppOperation,
  input: any,
  context: RequestContext,
): Request<any> {
  switch (operation) {
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
      const buttons: Record<string, any> = {
        back: webApp.BackButton,
        main: webApp.MainButton,
        secondary: webApp.SecondaryButton,
        settings: webApp.SettingsButton,
      };
      const button = buttons[input.button];
      if (!button) return unsupported(operation);
      const params = input.params;
      if (method(button, "setParams"))
        button.setParams({
          text: params.text,
          is_active: params.active,
          is_visible: params.visible,
          is_progress_visible: params.progressVisible,
          color: params.color,
          text_color: params.textColor,
          has_shine_effect: params.shine,
          position: params.position,
        });
      else {
        const actions: Array<() => void> = [];
        const add = (defined: boolean, name: string, action: () => void) => {
          if (!defined) return;
          if (!method(button, name))
            throw new MiniAppError(
              "unsupported",
              `${input.button} button does not support ${name}`,
            );
          actions.push(action);
        };
        try {
          add(params.text !== undefined, "setText", () =>
            button.setText(params.text),
          );
          add(params.progressVisible === true, "showProgress", () =>
            button.showProgress(params.active === true),
          );
          add(params.progressVisible === false, "hideProgress", () =>
            button.hideProgress(),
          );
          add(params.active === true, "enable", () => button.enable());
          add(params.active === false, "disable", () => button.disable());
          add(params.visible === true, "show", () => button.show());
          add(params.visible === false, "hide", () => button.hide());
          if (
            params.color !== undefined ||
            params.textColor !== undefined ||
            params.shine !== undefined ||
            params.position !== undefined
          ) {
            throw new MiniAppError(
              "unsupported",
              `${input.button} button requires setParams for styling`,
            );
          }
        } catch (error) {
          return Promise.reject(error);
        }
        for (const action of actions) action();
      }
      return resolved(undefined);
    }
    case "haptic": {
      const notification = ["success", "warning", "error"].includes(input.kind);
      const name = notification ? "notificationOccurred" : "impactOccurred";
      if (!method(webApp.HapticFeedback, name)) return unsupported(operation);
      webApp.HapticFeedback[name](input.kind);
      return resolved(undefined);
    }
    case "showPopup":
      if (!method(webApp, "showPopup")) return unsupported(operation);
      return callback(
        (done) =>
          webApp.showPopup(
            {
              title: input.title,
              message: input.message,
              buttons: input.buttons?.map((button: any) => ({
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
        (done) => webApp.readTextFromClipboard(done),
        (text) => (typeof text === "string" ? text : null),
      );
    case "getLocation": {
      const manager = webApp.LocationManager;
      if (!method(manager, "getLocation")) return unsupported(operation);
      return callback((done) => {
        const get = () => {
          if (!context.signal?.aborted) manager.getLocation(done);
        };
        manager.isInited || !method(manager, "init")
          ? get()
          : manager.init(get);
      }, normalizeLocation);
    }
    case "openLocationSettings":
      return command(webApp.LocationManager, "openSettings");
    case "getBiometryInfo": {
      const manager = webApp.BiometricManager;
      if (!manager) return unsupported(operation);
      return callback(
        (done) =>
          manager.isInited || !method(manager, "init")
            ? done()
            : manager.init(done),
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
      const manager = webApp.BiometricManager;
      if (!method(manager, "authenticate")) return unsupported(operation);
      return callback(
        (done) => manager.authenticate({ reason: input.reason }, done),
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
          webApp.downloadFile(
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
        (done) => webApp.openInvoice(input.url, done),
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
        (done) => webApp.SecureStorage.getItem(input.key, done),
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

function command(target: any, name: string, ...args: any[]): Promise<any> {
  if (!method(target, name)) return unsupported(name);
  target[name](...args);
  return resolved(undefined);
}
function booleanCallback(target: any, name: string, ...args: any[]) {
  if (!method(target, name)) return unsupported(name);
  return callback((done) => target[name](...args, done), strictBoolean);
}
const sensorOwners = new WeakMap<object, symbol>();

function sensorStart(
  target: any,
  params: any,
  context: RequestContext,
): Request<boolean> {
  if (!method(target, "start") || !method(target, "stop"))
    return unsupported("sensor start");
  // A caller must not acquire or later stop a sensor already owned elsewhere.
  if (target.isStarted === true) return resolved(false);
  const owner = Symbol();
  sensorOwners.set(target, owner);
  let completed = false;
  let cancelled = false;
  let released = false;
  const stopOwned = () => {
    if (sensorOwners.get(target) !== owner) return;
    try {
      target.stop();
    } catch {
      /* Cleanup must not replace the request result. */
    }
  };
  return {
    promise: new Promise<boolean>((resolve, reject) => {
      try {
        target.start(params, (value: unknown) => {
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
      if (!completed || context.signal?.aborted) {
        cancelled = true;
        stopOwned();
      }
    },
  };
}

function managerBoolean(target: any, name: string, params?: any) {
  if (!method(target, name)) return unsupported(name);
  return callback(
    (done) =>
      params === undefined ? target[name](done) : target[name](params, done),
    strictBoolean,
  );
}
function storage(
  target: any,
  name: string,
  args: any[],
  map: (value: any) => any,
) {
  if (!method(target, name)) return unsupported(name);
  return storageCallback(
    (done) => target[name](...args, done),
    (value) => map(value),
  );
}
function normalizeLocation(value: any) {
  if (!value || typeof value !== "object") return null;
  const nullable = (entry: any) => (typeof entry === "number" ? entry : null);
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

function strictBoolean(value: any): boolean {
  if (typeof value !== "boolean") throw invalid("Expected a boolean response");
  return value;
}
function strictOptionalString(value: any): string | null {
  if (typeof value === "string" || value === null) return value;
  throw invalid("Expected a string or null response");
}
function strictStringArray(value: any): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw invalid("Expected a string array response");
  }
  return [...value];
}
function strictStringRecord(value: any): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("Expected a string record response");
  }
  const result: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    if (typeof value[key] !== "string")
      throw invalid("Expected string record values");
    Object.defineProperty(result, key, {
      value: value[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}
