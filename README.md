# LO integrations and migration adapters

Native LO transports belong to their SDKs. New Mini Apps install only
`@lo-ink/miniapp-sdk` and call `createLoClient`; new bots install only
`@lo-ink/bot-sdk` and call `createLoBotClient`. The native adapter packages below
preserve existing imports through pure SDK re-exports. External host globals,
script loaders and compatibility wire shapes remain in explicit integrations.

| Package                              | Direction and responsibility                                          |
| ------------------------------------ | --------------------------------------------------------------------- |
| `@lo-ink/adapter-lo`                 | Compatibility re-export of native Mini App SDK transport              |
| `@lo-ink/adapter-lo-legacy`          | Explicit LO WebApp host support; no native composition                |
| `@lo-ink/adapter-telegram`           | LO SDK → Telegram host, with an explicit bounded script loader        |
| `@lo-ink/adapter-telegram-to-lo` 0.1 | Existing Telegram WebApp code → LO-provided compatibility surface     |
| `@lo-ink/adapter-webapp-compat`      | Shared translation implementation used only by compatibility adapters |
| `@lo-ink/adapter-vk`                 | LO SDK → official VK Bridge; limited documented capabilities          |
| `@lo-ink/bot-http-lo`                | Compatibility re-export of native Bot SDK HTTP transport              |

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

[Choosing an integration](docs/migration.md) describes explicit provider selection.

The bot migration suites use actual pinned Telegraf/grammY and aiogram clients
against a loopback HTTP recorder. They verify request contracts, not every
production server method. Hosted acceptance remains separate evidence.

`examples/vanilla.ts` is native LO only. The optional cross-platform example
requires `data-miniapp-host="lo-native"`, `"lo-legacy"` or `"telegram"` on its
entry document. It loads the external host script only for the explicit Telegram
entrypoint; missing native support inside LO never selects another provider.

Bot HTTP compatibility transport 0.6 re-exports the implementation from bot-sdk 0.5 and supports video, cached audio, homogeneous photo/document albums, metadata/download streams and typed callback/app-data updates. Installation capabilities are optional on older servers. See [the transport API](packages/bot-http-lo/README.md).

Compatibility guides live here: [bot migration](docs/telegram-bots.md), [mini-app migration](docs/telegram-miniapps.md), and [API mapping](docs/lo-vs-telegram.md).

Python integrations: [lo-aiogram](python/lo-aiogram/README.md) and the [LO Bot API emulator](python/lo-bot-api-emulator/README.md). Actual aiogram handlers and pinned Telegraf/grammY clients run against the generated strict contract; unsupported requests must fail explicitly. Unmodeled methods return 501. The fixture does not validate real media content or reproduce authentication, storage, transcoding and production permissions.

The [contract](contracts/lo-bot-api.json) records verified source provenance from [LO/messenger 285b2f31](https://git.lo.ink/LO/messenger/commit/285b2f31f809c55f22ad2cb74f6c4e035daa9926). Unsaved server changes require explicit `--allow-working-tree` and remain labeled unreleased. The server owns generation and its standard Go test checks source drift.

## Quality checks

The current native examples are checked separately against the published Mini App
SDK 0.23 with `make native-examples` (also part of `make ci`). This private
consumer uses Node.js 22.13 or newer and executes the actual vanilla example's
native lifecycle tests. The root workspace's Mini SDK 0.22 pin belongs to the
separate historical provider and migration package contracts; it is not the
recommended dependency for new native applications. Those existing package
versions and peer ranges remain unchanged, and native calls never fall back to
another provider.

Run `make install` and `make ci` with Node.js 22.13 or newer. The same targets run
in GitHub Actions. CI checks formatting, ESLint (including typed promises),
TypeScript, dependency cycles and package boundaries, tests, published package
contents, vulnerable dependencies and secrets. English documentation and comments
are enforced; unfinished development notes and retired repository URLs fail CI.

Coverage includes unimported production files and fails below 85% lines and
statements, 90% functions, or 75% branches. Reports are uploaded as CI artifacts.

Use `make python-install python-ci` for Ruff, mypy, Python tests with at least 85%
branch-inclusive coverage, distribution checks and pip-audit. `make bot-frameworks
strict-contract` verifies Telegraf and grammY against the explicit LO contract;
`make emulator-container` verifies the packaged emulator image. Use `PYTHON` to
select an installed Python 3.11+ interpreter.

Repository policy checks require Python 3 for Python comment tokenization. YAML
comments are parsed as YAML; embedded scripts and localized scalar values retain
their own language. LO credentials are checked by the root Gitleaks configuration
and a synthetic scanner regression before each repository scan.
