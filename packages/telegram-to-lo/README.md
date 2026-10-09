# `@lo-ink/adapter-telegram-to-lo` 0.2

Explicit inbound translation for selected Telegram WebApp calls on LO's canonical
native transport. New LO applications use `createLoClient` from
`@lo-ink/miniapp-sdk` directly and do not install this facade.

**Breaking change from 0.1.5.** This version requires Mini App SDK `^0.23.0` and
`LO.MiniAppNative`. It never reads `LO.WebApp` or loads a host script. Version 0.1.5
aliased the host's entire compatibility object; 0.2 implements the documented
subset below. Audit existing calls before upgrading. The old package remains a
historical registry artifact, not an automatic fallback.

## Explicit installation

Use a host that provides only the canonical native port. It must not automatically
inject `Telegram.WebApp` or compatibility aliases. Remove the Telegram script from
the LO entrypoint. An existing Telegram global with a WebApp is never replaced.

```ts
import { installTelegramCompatibility } from "@lo-ink/adapter-telegram-to-lo";

const lifetime = new AbortController();
const bridge = installTelegramCompatibility({
  signal: lifetime.signal,
  onError({ operation, error }) {
    // Required: show/report this operation failure in your application.
    showIntegrationError(operation, error.code);
  },
});
if (!bridge) throw new Error("This entrypoint requires the canonical LO host");
try {
  await import("./existing-app.js");
} catch (error) {
  await bridge.dispose();
  throw error;
}
addEventListener("pagehide", () => lifetime.abort(), { once: true });
// Application teardown that needs completion: await bridge.dispose().
```

Importing the package changes nothing. Methods retain callback/void semantics;
button methods are chainable. Unsupported calls and exhausted local bounds throw
synchronously. Asynchronous native failure never becomes permission denial or
success. Error-first storage callbacks receive their error. Other asynchronous
errors go exactly once to each active lease's required `onError`; ignored void
calls cannot produce an unhandled rejected operation Promise. A throwing success
callback is reported there too. Messages and causes from native failures are not
exposed. An `onError` handler must not throw or reject: a violating handler becomes
an uncaught sanitized programming error, not an unhandled Promise rejection.

Multiple installers own leases of the same document. The final lease aborts and
joins owned requests, unsubscribes events and restores only property descriptors
still owned by this installation. Foreign replacement globals survive cleanup.
Document generation, native port identity and exact launch assertion are bound;
stale calls throw, and late success callbacks/events are suppressed. Dispose the
old installation before a new session. Aborting one lease leaves other leases
active. Disposal cancellation is expected teardown and produces no success or
failure callback after the last owner is gone.

The documented per-installation limits are 32 pending requests, 128 distinct event
listeners and 16 leases. Native SDK deadlines and native-host limits still apply.
There is no queue, unbounded retry, alternate transport or version inflation.

## Supported translation and explicit exclusions

Every operation additionally requires its negotiated native operation/capability.
The presence of a method does not manufacture host support. In particular `expand`
throws `unsupported` when the host does not implement expansion.

| Surface                                                                                                                                | Contract                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initData`                                                                                                                             | Original signed bytes, unchanged. Verify with LO on the backend.                                                                                                                                                    |
| `initDataUnsafe`                                                                                                                       | Display-only canonical fields translated to snake_case; user IDs stay exact strings. No authentication claim.                                                                                                       |
| Theme, viewport, safe/content insets, fullscreen, orientation lock, theme colors                                                       | Current native snapshot values. Unknown remains undefined; content inset adds canonical system and content contributions only when both are known.                                                                  |
| ready/close/expand/fullscreen/hideKeyboard, orientation/closing/swipe controls, colors, sendData, openLink, switchInlineQuery, haptics | Canonical requests. `close` options, `openLink.try_browser` and unknown mapped input keys explicitly refuse.                                                                                                        |
| Back/Main/Secondary/Settings buttons                                                                                                   | Mutations and click listeners. Button state getters are not supplied. `showProgress(true)` preserves activity; default/false refuses because prior activity cannot be restored faithfully from the native snapshot. |
| Popup/alert/confirm, clipboard, contact/write permission, prepared share, story, download                                              | Callback results from canonical completion; false is a real negative result. No callback is fabricated after a failure.                                                                                             |
| Cloud/Device/SecureStorage                                                                                                             | Error-first callbacks, canonical values; SecureStorage get includes the `canRestore` third argument.                                                                                                                |
| Events                                                                                                                                 | activated/deactivated, theme/viewport/insets/fullscreen, button clicks and negotiated QR text/closure events. `viewportChanged.isStateStable` is undefined because the canonical event does not attest stability.   |
| Invoice                                                                                                                                | Requires actual native support; current canonical SDK does not provide it, so refuses.                                                                                                                              |
| `version`, `isVersionAtLeast`, `platform`, `isExpanded`, `isActive`, closing/swipe state getters                                       | Explicit unsupported errors. Package version, equal viewport heights and fullscreen are not evidence for these values.                                                                                              |
| Sensor/Biometric/Location managers, QR command/callback session, home-screen APIs, `openTelegramLink`                                  | Explicit unsupported errors in 0.2; migrate these flows to typed canonical operations where supported. No host-shim delegation.                                                                                     |

No complete Telegram parity is promised. There is no `Telegram.WebView`,
`TelegramWebviewProxy`, automatic CSS-variable injection or foreign script emulation.
Unsupported shapes must be migrated explicitly. Supported event callbacks are
owned by the installation; disposal removes them. Application-owned work started
inside a callback remains the application's responsibility.

## Backend and host migration

The assertion and identity provider remain LO even when application code reads
`Telegram.WebApp.initData`. Use LO verification and LO-issued server credentials;
a Telegram bot token cannot verify this assertion. Keep provider IDs separate.

The native host's old automatic shim must be retired in a separately reviewed
host change before this entrypoint can install there. A package-only release does
not certify that native change or a production host. Local native-port tests are
bounded contract evidence. Once foreign API calls are migrated, remove this
facade and use `createLoClient` directly.
