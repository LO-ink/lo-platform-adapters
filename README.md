# LO platform adapters

Host-specific adapters for `@lo/miniapp-sdk`. Platform globals, version gates, wire names, and callback shapes live here instead of the canonical SDK.

- `@lo/adapter-lo` 0.20 prefers `LO.MiniAppNative` for `ready`, `expand`, `setClosingConfirmation`, `openLink`, `sendData`, and `requestWriteAccess`, and composes a matching-session `LO.WebApp` fallback for remaining capabilities.
- `@lo/adapter-telegram` detects a Telegram host and can load the official browser script with a bounded, coalesced loader.
- `@lo/adapter-webapp-compat` contains shared translation code used by both public adapters.
- `@lo/adapter-vk` initializes the official VK Bridge and normalizes host appearance, viewport, safe-area and lifecycle events.
- `@lo/bot-http-lo` implements the server-side HTTP transport for `@lo/bot-sdk`.

The native LO slice is intentionally bounded: `activated` and `deactivated` are canonical, while dynamic theme, viewport, safe-area, and fullscreen updates remain on the matching legacy fallback. Released-client acceptance is still pending. Each adapter documents its supported capabilities; hosted VK authentication and production conformance have not been verified by the local fixture suite.

```sh
npm ci
npm test
npm run check
npm run format:check
```

See [`docs/0.18.0-inventory.md`](docs/0.18.0-inventory.md) for the migration inventory and explicit gaps.

[`compatibility/bot-frameworks`](compatibility/bot-frameworks) tests pinned Telegraf and grammY packages against a loopback HTTP server, including multipart uploads, file downloads, and typed errors. It does not imply full server API coverage.

[`compatibility/aiogram`](compatibility/aiogram) covers the same HTTP boundary with the Python aiogram client and includes custom server configuration.
