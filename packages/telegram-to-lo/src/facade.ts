import {
  MiniAppError,
  type MiniAppClient,
  type LoNativeAdapter,
  type MiniAppOperation,
  type MiniAppEvent,
  type OperationInput,
  type OperationOutput,
  type ButtonId,
  type ButtonParams,
} from "@lo-ink/miniapp-sdk";

export type Failure = Readonly<{ operation: string; error: MiniAppError }>;
export type Listener = (...values: unknown[]) => void;
type StorageCallback<T> = (
  error: MiniAppError | null,
  value?: T,
  extra?: boolean,
) => void;
export const COMPATIBILITY_LIMITS = Object.freeze({
  requests: 32,
  listeners: 128,
  leases: 16,
});
export const unsupported = (name: string): never => {
  throw new MiniAppError(
    "unsupported",
    `Unsupported compatibility feature: ${name}`,
  );
};
function keys(value: unknown, allowed: readonly string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new MiniAppError(
      "unsupported",
      "Unsupported compatibility input fields",
    );
}
const themeKeys = {
  background: "bg_color",
  text: "text_color",
  mutedText: "hint_color",
  link: "link_color",
  action: "button_color",
  actionText: "button_text_color",
  secondaryBackground: "secondary_bg_color",
  headerBackground: "header_bg_color",
  accentText: "accent_text_color",
  sectionBackground: "section_bg_color",
  sectionHeaderText: "section_header_text_color",
  subtitleText: "subtitle_text_color",
  destructiveText: "destructive_text_color",
  bottomBarBackground: "bottom_bar_bg_color",
} as const;
const eventMap = {
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
  scanQrPopupClosed: "qrScannerClosed",
} as const satisfies Record<string, MiniAppEvent>;

/** Callback-shaped compatibility, with a mandatory error channel for void methods. */
export function createFacade(
  client: MiniAppClient,
  live: () => boolean,
  report: (failure: Failure) => void,
) {
  const adapter = client.adapter as LoNativeAdapter;
  const controller = new AbortController();
  const pending = new Set<Promise<void>>();
  const listeners = new Map<string, Map<Listener, () => void>>();
  let stopped = false;
  const active = () => !stopped && live();
  const assertActive = () => {
    if (!active())
      throw new MiniAppError(
        "disposed",
        "Compatibility session is no longer active",
      );
  };
  const sanitized = (error: unknown) =>
    new MiniAppError(error instanceof MiniAppError ? error.code : "failed");
  const deliver = (operation: string, callback: () => unknown) => {
    if (!active()) return;
    const failed = () => {
      if (active())
        report({
          operation,
          error: new MiniAppError("failed", "Compatibility callback failed"),
        });
    };
    try {
      const value = callback();
      if (value && typeof (value as PromiseLike<unknown>).then === "function")
        void Promise.resolve(value).catch(failed);
    } catch {
      failed();
    }
  };
  function request<K extends MiniAppOperation>(
    operation: K,
    input: OperationInput<K>,
    callback?: (value: OperationOutput<K>) => void,
    failure?: (error: MiniAppError) => void,
  ): void {
    assertActive();
    if (!adapter.nativeSupports(operation, input)) unsupported(operation);
    if (pending.size >= COMPATIBILITY_LIMITS.requests)
      throw new MiniAppError("failed", "Compatibility request limit reached");
    const work = client
      .call(operation, input, { signal: controller.signal })
      .then(
        (value) => {
          if (callback) deliver(operation, () => callback(value));
        },
        (error) => {
          if (active()) {
            const safe = sanitized(error);
            if (failure) deliver(operation, () => failure(safe));
            else report({ operation, error: safe });
          }
        },
      )
      .finally(() => pending.delete(work));
    pending.add(work);
  }
  function onEvent(name: string, callback: Listener): void {
    assertActive();
    const event = eventMap[name as keyof typeof eventMap];
    if (!event || !adapter.nativeEvents.has(event))
      unsupported(`event:${name}`);
    if (typeof callback !== "function")
      throw new TypeError("Event listener must be a function");
    if (listeners.get(name)?.has(callback)) return;
    if (
      [...listeners.values()].reduce((sum, group) => sum + group.size, 0) >=
      COMPATIBILITY_LIMITS.listeners
    )
      throw new MiniAppError("failed", "Compatibility listener limit reached");
    const remove = client.on(event, (payload) =>
      deliver(`event:${name}`, () => {
        if (event === "qrTextReceived")
          return callback((payload as { data: string }).data);
        else if (event === "fullscreenFailed")
          return callback({ error: (payload as { reason?: string }).reason });
        else if (event === "viewportChanged")
          return callback({ isStateStable: undefined });
        else return callback();
      }),
    );
    const group = listeners.get(name) ?? new Map();
    group.set(callback, remove);
    listeners.set(name, group);
  }
  function offEvent(name: string, callback: Listener): void {
    const group = listeners.get(name);
    group?.get(callback)?.();
    group?.delete(callback);
    if (group?.size === 0) listeners.delete(name);
  }
  const snapshot = () => {
    assertActive();
    return adapter.snapshot();
  };
  function button(id: ButtonId) {
    const event = `${id}ButtonClicked`;
    const params = (patch: ButtonParams) =>
      request("setButton", { button: id, params: patch });
    const result = {
      show() {
        params({ visible: true });
        return result;
      },
      hide() {
        params({ visible: false });
        return result;
      },
      enable() {
        params({ active: true });
        return result;
      },
      disable() {
        params({ active: false });
        return result;
      },
      setText(text: string) {
        params({ text });
        return result;
      },
      setParams(input: {
        text?: string;
        color?: string;
        text_color?: string;
        is_active?: boolean;
        is_visible?: boolean;
        has_shine_effect?: boolean;
        position?: ButtonParams["position"];
      }) {
        keys(input, [
          "text",
          "color",
          "text_color",
          "is_active",
          "is_visible",
          "has_shine_effect",
          "position",
        ]);
        params({
          text: input.text,
          color: input.color,
          textColor: input.text_color,
          active: input.is_active,
          visible: input.is_visible,
          shine: input.has_shine_effect,
          position: input.position,
        });
        return result;
      },
      showProgress(leaveActive = false) {
        if (!leaveActive)
          unsupported(
            "showProgress requires leaveActive=true: prior button activity is not observable",
          );
        params({ progressVisible: true });
        return result;
      },
      hideProgress() {
        params({ progressVisible: false });
        return result;
      },
      onClick(callback: Listener) {
        onEvent(event, callback);
        return result;
      },
      offClick(callback: Listener) {
        offEvent(event, callback);
        return result;
      },
    };
    return Object.freeze(result);
  }
  function storage<K extends MiniAppOperation>(
    operation: K,
    input: OperationInput<K>,
    callback?: StorageCallback<OperationOutput<K>>,
  ) {
    request(
      operation,
      input,
      callback ? (value) => callback(null, value) : undefined,
      callback ? (error) => callback(error) : undefined,
    );
  }
  const WebApp = {
    get initData() {
      assertActive();
      return adapter.launchData;
    },
    get initDataUnsafe() {
      assertActive();
      const data = client.launchUnsafe(),
        user = data.user;
      return {
        query_id: data.queryId,
        auth_date: data.authDate,
        start_param: data.startParam,
        chat_type: data.chatType,
        app_id: data.appId,
        user: user
          ? {
              id: user.id,
              first_name: user.firstName,
              last_name: user.lastName,
              username: user.username,
              photo_url: user.photoUrl,
              language_code: user.languageCode,
            }
          : undefined,
      };
    },
    get capabilities() {
      assertActive();
      return Object.freeze(
        [...adapter.capabilities].filter(
          (value) =>
            !["biometry", "sensors", "location", "qrScanner"].includes(value),
        ),
      );
    },
    get colorScheme() {
      return snapshot().colorScheme;
    },
    get themeParams() {
      const theme = snapshot().theme ?? {};
      return Object.fromEntries(
        Object.entries(themeKeys).flatMap(([native, legacy]) => {
          const value = theme[native as keyof typeof themeKeys];
          return value === undefined ? [] : [[legacy, value]];
        }),
      );
    },
    get viewportHeight() {
      return snapshot().viewportHeight;
    },
    get viewportStableHeight() {
      return snapshot().stableViewportHeight;
    },
    get safeAreaInset() {
      return snapshot().safeArea;
    },
    get contentSafeAreaInset() {
      const s = snapshot();
      if (!s.safeArea || !s.contentSafeArea) return undefined;
      return {
        top: s.safeArea.top + s.contentSafeArea.top,
        right: s.safeArea.right + s.contentSafeArea.right,
        bottom: s.safeArea.bottom + s.contentSafeArea.bottom,
        left: s.safeArea.left + s.contentSafeArea.left,
      };
    },
    get isFullscreen() {
      return snapshot().isFullscreen;
    },
    get isOrientationLocked() {
      return snapshot().isOrientationLocked;
    },
    get headerColor() {
      return snapshot().theme?.headerBackground;
    },
    get backgroundColor() {
      return snapshot().theme?.background;
    },
    get bottomBarColor() {
      return snapshot().theme?.bottomBarBackground;
    },
    get isActive(): never {
      return unsupported("isActive");
    },
    get isClosingConfirmationEnabled(): never {
      return unsupported("isClosingConfirmationEnabled");
    },
    get isVerticalSwipesEnabled(): never {
      return unsupported("isVerticalSwipesEnabled");
    },
    get version(): never {
      return unsupported("version");
    },
    get platform(): never {
      return unsupported("platform");
    },
    get isExpanded(): never {
      return unsupported("isExpanded");
    },
    isVersionAtLeast(): never {
      return unsupported("isVersionAtLeast");
    },
    onEvent,
    offEvent,
    ready() {
      request("ready", undefined);
    },
    close(options?: unknown) {
      if (options !== undefined) unsupported("close options");
      request("close", undefined);
    },
    expand() {
      request("expand", undefined);
    },
    requestFullscreen() {
      request("requestFullscreen", undefined);
    },
    exitFullscreen() {
      request("exitFullscreen", undefined);
    },
    hideKeyboard() {
      request("hideKeyboard", undefined);
    },
    lockOrientation() {
      request("setOrientationLock", { locked: true });
    },
    unlockOrientation() {
      request("setOrientationLock", { locked: false });
    },
    enableClosingConfirmation() {
      request("setClosingConfirmation", { enabled: true });
    },
    disableClosingConfirmation() {
      request("setClosingConfirmation", { enabled: false });
    },
    enableVerticalSwipes() {
      request("setVerticalSwipes", { enabled: true });
    },
    disableVerticalSwipes() {
      request("setVerticalSwipes", { enabled: false });
    },
    setHeaderColor(color: string) {
      request("setHeaderColor", { color });
    },
    setBackgroundColor(color: string) {
      request("setBackgroundColor", { color });
    },
    setBottomBarColor(color: string) {
      request("setBottomBarColor", { color });
    },
    openLink(
      url: string,
      options?: { try_instant_view?: boolean; try_browser?: string },
    ) {
      if (options) keys(options, ["try_instant_view", "try_browser"]);
      if (options?.try_browser !== undefined)
        unsupported("openLink.try_browser");
      request("openLink", { url, instantView: options?.try_instant_view });
    },
    openTelegramLink(): never {
      return unsupported("openTelegramLink");
    },
    sendData(data: string) {
      request("sendData", { data });
    },
    switchInlineQuery(
      query: string,
      chatTypes?: OperationInput<"switchInlineQuery">["chatTypes"],
    ) {
      request("switchInlineQuery", { query, chatTypes });
    },
    requestWriteAccess(callback?: (allowed: boolean) => void) {
      request("requestWriteAccess", undefined, callback);
    },
    requestContact(callback?: (sent: boolean) => void) {
      request("requestContact", undefined, callback);
    },
    readTextFromClipboard(callback: (value: string | null) => void) {
      request("readClipboard", undefined, callback);
    },
    shareMessage(id: string, callback?: (sent: boolean) => void) {
      request("shareMessage", { id }, callback);
    },
    shareToStory(
      mediaUrl: string,
      params?: { text?: string; widget_link?: { url: string; name?: string } },
    ) {
      if (params) keys(params, ["text", "widget_link"]);
      if (params?.widget_link) keys(params.widget_link, ["url", "name"]);
      request("shareToStory", {
        mediaUrl,
        params: params
          ? { text: params.text, link: params.widget_link }
          : undefined,
      });
    },
    downloadFile(
      params: { url: string; file_name: string },
      callback?: (downloaded: boolean) => void,
    ) {
      keys(params, ["url", "file_name"]);
      request(
        "downloadFile",
        { url: params.url, fileName: params.file_name },
        callback,
      );
    },
    openInvoice(
      url: string,
      callback?: (status: OperationOutput<"openInvoice">) => void,
    ) {
      request("openInvoice", { url }, callback);
    },
    showPopup(
      params: {
        title?: string;
        message: string;
        buttons?: readonly {
          id?: string;
          text?: string;
          type?: "default" | "ok" | "close" | "cancel" | "destructive";
        }[];
      },
      callback?: (id: string | undefined) => void,
    ) {
      keys(params, ["title", "message", "buttons"]);
      params.buttons?.forEach((button) => keys(button, ["id", "text", "type"]));
      request(
        "showPopup",
        {
          title: params.title,
          message: params.message,
          buttons: params.buttons?.map(({ type, ...rest }) => ({
            ...rest,
            kind: type,
          })),
        },
        callback,
      );
    },
    showAlert(message: string, callback?: () => void) {
      request("showPopup", { message, buttons: [{ kind: "close" }] }, callback);
    },
    showConfirm(message: string, callback?: (confirmed: boolean) => void) {
      request(
        "showPopup",
        {
          message,
          buttons: [
            { id: "yes", kind: "ok" },
            { id: "no", kind: "cancel" },
          ],
        },
        callback ? (id) => callback(id === "yes") : undefined,
      );
    },
    MainButton: button("main"),
    SecondaryButton: button("secondary"),
    BackButton: button("back"),
    SettingsButton: button("settings"),
    HapticFeedback: Object.freeze({
      impactOccurred(kind: "light" | "medium" | "heavy" | "rigid" | "soft") {
        request("haptic", { kind });
      },
      notificationOccurred(kind: "success" | "warning" | "error") {
        request("haptic", { kind });
      },
      selectionChanged() {
        request("haptic", { kind: "selection" });
      },
    }),
    CloudStorage: Object.freeze({
      setItem(key: string, value: string, cb?: StorageCallback<boolean>) {
        storage("cloudStorageSet", { key, value }, cb);
      },
      getItem(key: string, cb: StorageCallback<string>) {
        storage("cloudStorageGet", { key }, cb);
      },
      getItems(
        keys: readonly string[],
        cb: StorageCallback<Record<string, string>>,
      ) {
        storage("cloudStorageGetMany", { keys }, cb);
      },
      removeItem(key: string, cb?: StorageCallback<boolean>) {
        storage("cloudStorageRemove", { key }, cb);
      },
      removeItems(keys: readonly string[], cb?: StorageCallback<boolean>) {
        storage("cloudStorageRemoveMany", { keys }, cb);
      },
      getKeys(cb: StorageCallback<string[]>) {
        storage("cloudStorageKeys", undefined, cb);
      },
    }),
    DeviceStorage: Object.freeze({
      setItem(key: string, value: string, cb?: StorageCallback<boolean>) {
        storage("deviceStorageSet", { key, value }, cb);
      },
      getItem(key: string, cb: StorageCallback<string | null>) {
        storage("deviceStorageGet", { key }, cb);
      },
      removeItem(key: string, cb?: StorageCallback<boolean>) {
        storage("deviceStorageRemove", { key }, cb);
      },
      clear(cb?: StorageCallback<boolean>) {
        storage("deviceStorageClear", undefined, cb);
      },
    }),
    SecureStorage: Object.freeze({
      setItem(key: string, value: string, cb?: StorageCallback<boolean>) {
        storage("secureStorageSet", { key, value }, cb);
      },
      getItem(key: string, cb: StorageCallback<string | null>) {
        request(
          "secureStorageGet",
          { key },
          (value) => cb(null, value.value, value.canRestore),
          (error) => cb(error),
        );
      },
      restoreItem(key: string, cb: StorageCallback<string>) {
        storage("secureStorageRestore", { key }, cb);
      },
      removeItem(key: string, cb?: StorageCallback<boolean>) {
        storage("secureStorageRemove", { key }, cb);
      },
      clear(cb?: StorageCallback<boolean>) {
        storage("secureStorageClear", undefined, cb);
      },
    }),
    get BiometricManager(): never {
      return unsupported("BiometricManager");
    },
    get LocationManager(): never {
      return unsupported("LocationManager");
    },
    get Accelerometer(): never {
      return unsupported("Accelerometer");
    },
    get Gyroscope(): never {
      return unsupported("Gyroscope");
    },
    get DeviceOrientation(): never {
      return unsupported("DeviceOrientation");
    },
    showScanQrPopup(): never {
      return unsupported("showScanQrPopup");
    },
    closeScanQrPopup(): never {
      return unsupported("closeScanQrPopup");
    },
    addToHomeScreen(): never {
      return unsupported("addToHomeScreen");
    },
    checkHomeScreenStatus(): never {
      return unsupported("checkHomeScreenStatus");
    },
  };
  return {
    webApp: Object.freeze(WebApp),
    async stop() {
      if (!stopped) {
        stopped = true;
        controller.abort();
        for (const group of listeners.values())
          for (const remove of group.values()) remove();
        listeners.clear();
        client.dispose();
      }
      await Promise.all(pending);
    },
  };
}
export type TelegramWebApp = ReturnType<typeof createFacade>["webApp"];
