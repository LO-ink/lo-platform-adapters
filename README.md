# LO integrations and migration adapters

The native LO API and compatibility integrations are separate packages. Platform
globals, external scripts, version gates and foreign wire shapes never belong in
`@lo-ink/miniapp-sdk`.

| Package                              | Direction and responsibility                                          |
| ------------------------------------ | --------------------------------------------------------------------- |
| `@lo-ink/adapter-lo` 0.22            | Native LO SDK → native LO protocol; no compatibility dependency       |
| `@lo-ink/adapter-lo-legacy` 0.1      | Explicit older LO host support; preserves 0.21 composition semantics  |
| `@lo-ink/adapter-telegram`           | LO SDK → Telegram host, with an explicit bounded script loader        |
| `@lo-ink/adapter-telegram-to-lo` 0.1 | Existing Telegram WebApp code → LO-provided compatibility surface     |
| `@lo-ink/adapter-webapp-compat`      | Shared translation implementation used only by compatibility adapters |
| `@lo-ink/adapter-vk`                 | LO SDK → official VK Bridge; limited documented capabilities          |
| `@lo-ink/bot-http-lo`                | Server HTTP transport for the native LO Bot SDK                       |

Each adapter reports actual host capabilities. Unsupported operations reject;
no native failure is replayed through a different transport. Browser discovery
is inert during server rendering. Signed launch data stays opaque and requires
server verification for its actual provider.

## Development

```sh
npm ci
npm test
npm run check
npm run format:check
npm run test:package
```

Tests cover native protocol validation, document/session isolation, cancellation,
timeouts, late results, permission denial, events and compatibility leases.
Packed-package tests install the native SDK and LO adapter **alone**, proving
that the native application needs no compatibility package. A second consumer
checks all adapters through their public exports and TypeScript declarations.

[`docs/migration.md`](docs/migration.md) describes upgrade directions and the
prepared release order. [`docs/0.18.0-inventory.md`](docs/0.18.0-inventory.md)
retains the historical migration inventory.

The bot migration suites use actual pinned Telegraf/grammY and aiogram clients
against a loopback HTTP recorder. They verify request contracts, not every
production server method. Hosted acceptance remains separate evidence.

`examples/vanilla.ts` is native LO only. The optional cross-platform example
requires `data-miniapp-host="lo-native"`, `"lo-legacy"` or `"telegram"` on its
entry document. It loads the external host script only for the explicit Telegram
entrypoint; missing native support inside LO never selects another provider.

Bot HTTP transport 0.4 uses native LO keyboard values from bot-sdk 0.4 and supports video, cached audio, homogeneous photo/document albums, metadata/download streams and typed callback/app-data updates. Installation capabilities are optional on older servers. See [the transport API](packages/bot-http-lo/README.md).

Compatibility guides live here: [bot migration](docs/telegram-bots.md), [mini-app migration](docs/telegram-miniapps.md), and [API mapping](docs/lo-vs-telegram.md).
