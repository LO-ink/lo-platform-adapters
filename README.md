# LO integrations and migration adapters

New LO Mini Apps use `createLoClient` from `@lo-ink/miniapp-sdk`; new bots use
`createLoBotClient` from `@lo-ink/bot-sdk`. Neither needs an adapter package.

| Package                          | Integration                                                  |
| -------------------------------- | ------------------------------------------------------------ |
| `@lo-ink/adapter-lo`             | Existing imports for the native Mini App SDK transport       |
| `@lo-ink/bot-http-lo`            | Existing imports for the native Bot SDK HTTP transport       |
| `@lo-ink/adapter-telegram`       | LO SDK application running in Telegram                       |
| `@lo-ink/adapter-telegram-to-lo` | Selected Telegram WebApp calls on LO's canonical native port |
| `@lo-ink/adapter-webapp-compat`  | Shared implementation for external WebApp adapters           |
| `@lo-ink/adapter-vk`             | LO SDK application using official VK Bridge                  |

Select external providers explicitly. Adapters report actual host capabilities;
unsupported operations reject, and failed native requests never switch transport.
Imports are inert during server rendering. Verify signed launch data on your
backend with the issuing provider's key, preserving the signed bytes.

## Guides and examples

- [Telegram bots](docs/telegram-bots.md), [lo-aiogram](python/lo-aiogram/README.md)
  and the [Bot API emulator](python/lo-bot-api-emulator/README.md).
- [Existing Telegram Mini Apps](packages/telegram-to-lo/README.md),
  [Telegram host adapter](packages/telegram/README.md), and
  [LO/Telegram differences](docs/lo-vs-telegram.md).
- [Bot HTTP transport](packages/bot-http-lo/README.md) and
  [secretary operations](docs/secretary.md).

`examples/vanilla.ts` uses native LO only. `examples/cross-platform.ts` selects
`lo-native` or `telegram` from the entry document's `data-miniapp-host` attribute;
only the Telegram entrypoint loads its host script.

The [Bot API contract](contracts/lo-bot-api.json) is generated from verified,
committed server source. Generation rejects dirty source and omits private source
provenance from public artifacts. Fixture success does not establish production
storage, authentication, transcoding, permissions or provider/device behavior.

## Development

Use Node.js 22.13+ and Python 3.11+:

```sh
make install
make ci
make python-install python-ci
make bot-frameworks strict-contract
make emulator-container
```

Set `PYTHON` to select another Python interpreter. The gates check formatting,
lint, types, dependency boundaries, coverage, packed consumers, vulnerabilities
and secrets. Python checks also cover wheel/sdist consumers and require at least
85% branch-inclusive coverage. JavaScript requires 85% lines/statements, 90%
functions and 75% branches.

Packed consumers check public exports, strict peer installation, SSR and
NodeNext/Bundler types at supported SDK floors. See each adapter's README for its
version range. `make native-examples` (included in `make ci`) checks the native
examples against Mini App SDK 0.23 separately from the root's 0.22 development pin.
