# Moving an existing Telegram Mini App to LO

There are two separate migration paths.

## Retain existing WebApp calls initially

Use `@lo-ink/adapter-telegram-to-lo` on your LO entrypoint. Remove the official
Telegram script there and install the bridge before importing existing code:

```ts
import { installTelegramCompatibility } from "@lo-ink/adapter-telegram-to-lo";

const bridge = installTelegramCompatibility();
if (!bridge) throw new Error("Open this entrypoint inside LO");
await import("./existing-app.js");
addEventListener("pagehide", () => bridge.dispose(), { once: true });
```

The LO host must already expose its supported WebApp compatibility surface.
The bridge exposes that exact object under the existing API name. It does not
invent missing methods, change its version, modify launch bytes or authenticate
the user. Existing Telegram globals are never overwritten.

**Change backend verification for the LO entrypoint.** The launch assertion is
issued by LO even if application code reads `Telegram.WebApp.initData`. Validate
with the LO algorithm and credentials, then issue your own application session.
Do not use a Telegram bot token to verify LO launch data. Keep provider user IDs
separate; equal numeric IDs are not account links.

Audit version gates, links, invoices, API methods and permission flows against
the actual released host. Local adapter tests are not complete production parity.

## Move the application to the typed LO API

Use the native [Mini App guide](https://github.com/LO-ink/lo-developer-tools/blob/main/docs/miniapps.md) for new domain code. If the same
application must also run in Telegram, select its outbound adapter only in the
composition root:

```ts
import {
  createMiniAppClient,
  createNativeAdapter as createLoAdapter,
} from "@lo-ink/miniapp-sdk";
import { createAdapter as createTelegramAdapter } from "@lo-ink/adapter-telegram";

// Configure the entrypoint explicitly; this does not authenticate a provider.
const host: "lo" | "telegram" = configuredHost;
const adapter = host === "lo" ? createLoAdapter() : createTelegramAdapter();
const client = adapter ? createMiniAppClient(adapter) : null;
```

LO requires the native Mini App SDK transport. An absent native port is
unsupported; no WebApp adapter is selected as a fallback. Host capabilities
must be checked independently of package versions.

| Existing call                        | Typed application call                                                    |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `WebApp.ready()`                     | `client.call('ready', undefined)`                                         |
| `WebApp.BackButton.show()`           | `client.call('setButton', { button: 'back', params: { visible: true } })` |
| `WebApp.BackButton.onClick(handler)` | `client.on('backButtonClicked', handler)`; retain its cleanup handle      |
| Raw `themeParams`                    | `client.adapter.snapshot().theme`, using semantic roles                   |
| Foreign host version checks          | `client.supports(capability)`                                             |

Foreign-only extensions stay in their adapter. Optional UI adoption is separate:
`@lo-ink/ui` takes values and actions, and never selects or authenticates a host.
Remove the inbound bridge once existing foreign API calls have been migrated.

See [adapter migration and release order](https://github.com/LO-ink/lo-platform-adapters/blob/main/docs/migration.md).
