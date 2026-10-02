# `@lo-ink/adapter-telegram-to-lo`

Explicit migration bridge for an existing Telegram WebApp application opened
inside LO. This is the inbound direction. `@lo-ink/adapter-telegram` is the
outbound direction: it runs code written against the LO SDK inside Telegram.

## Minimal transition

Remove the official Telegram script from the LO entrypoint. Before importing the
existing application, install the bridge:

```ts
import { installTelegramCompatibility } from "@lo-ink/adapter-telegram-to-lo";

const bridge = installTelegramCompatibility();
if (!bridge)
  throw new Error("This entrypoint requires an LO compatibility host");

try {
  await import("./existing-app.js");
} catch (error) {
  bridge.dispose();
  throw error;
}
addEventListener("pagehide", () => bridge.dispose(), { once: true });
```

The LO container must already provide `LO.WebApp` with launch data and an explicit
capability list. This bridge exposes that exact object as `Telegram.WebApp`.
It preserves method receivers, callbacks, events, permission denial, capability
limits and signed launch bytes. It neither downloads code nor invents missing
methods or a newer version. Importing the package alone changes nothing.

An existing `Telegram.WebApp` is never replaced. Multiple installers acquire
leases; the last disposal restores the original property descriptor. Cleanup
preserves a global replaced by another owner. Application event listeners and
in-flight actions remain the existing application's responsibility.

## Backend changes are required

The API spelling does not change the identity provider. On the LO entrypoint,
send the unchanged assertion to **LO verification** on your backend, then issue
your own application session. Do not validate it with a Telegram bot token.
Keep provider identifiers separate; equal numeric IDs do not link accounts.
Use LO-issued bot credentials only on your server.

Audit the existing application's methods, version checks, invoice flows,
provider links and authorization before routing production users into LO.
Unsupported host methods remain unsupported. The local contract suite is not a
claim of complete Telegram parity or production host acceptance.

For gradual migration, replace application calls with the typed LO SDK and
remove this bridge when no foreign API calls remain. New applications should
start directly with `@lo-ink/miniapp-sdk` and `@lo-ink/adapter-lo`.
