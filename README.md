# LO platform adapters

Host-specific adapters for `@lo/miniapp-sdk`. Platform globals, version gates, wire names, and callback shapes live here instead of the canonical SDK.

- `@lo/adapter-lo` wraps the legacy compatibility object injected by current LO clients. Its `lo-legacy-webapp` identity makes the transition explicit.
- `@lo/adapter-telegram` detects a Telegram host and can load the official browser script with a bounded, coalesced loader.
- `@lo/adapter-webapp-compat` contains shared translation code used by both public adapters.
- `@lo/adapter-vk` initializes the official VK Bridge and normalizes host appearance, viewport, safe-area and lifecycle events.
- `@lo/bot-http-lo` implements the server-side HTTP transport for `@lo/bot-sdk`.

The native LO bridge migration is separate work. Each adapter documents its supported capabilities; hosted VK authentication and production conformance have not been verified by the local fixture suite.

```sh
npm ci
npm test
npm run check
npm run format:check
```

See [`docs/0.18.0-inventory.md`](docs/0.18.0-inventory.md) for the migration inventory and explicit gaps.

[`compatibility/bot-frameworks`](compatibility/bot-frameworks) tests pinned Telegraf and grammY packages against a loopback HTTP server, including multipart uploads, file downloads, and typed errors. It does not imply full server API coverage.
