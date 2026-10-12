# `@lo-ink/adapter-telegram`

Adapter for Mini Apps running inside Telegram. `createAdapter()` performs synchronous discovery. `loadAdapter()` optionally loads Telegram's official browser script once with a bounded timeout and removes the script node afterward.

The returned `TelegramMiniAppAdapter` also exposes provider-only `telegram.requestChat`, `telegram.setEmojiStatus`, and `telegram.openTelegramLink` extensions. These do not enter the portable LO operation map.

```ts
import { loadAdapter } from "@lo-ink/adapter-telegram";

const adapter = await loadAdapter();
```

Keyboard Mini Apps may opt into `createAdapter(scope, { allowEmptyLaunchData: true })` or the same `loadAdapter` option. This only enables host interaction; an empty payload never authenticates a user. Default discovery continues to require launch data.

`adapter.telegram.supports(feature)` owns extension version/method checks. Extensions cover prepared chats, emoji status, internal links, home-screen shortcuts and vertical swipes. Home-screen installation prompts do not imply successful installation; use the status callback and optional notification. `verticalSwipesEnabled()` exposes the current state for reversible changes.

## SDK compatibility

The adapter supports Mini App SDK `^0.19.2 || ^0.20.0 || ^0.21.0 || ^0.22.0 || ^0.23.0`.
Packed consumers are tested with strict peer resolution at 0.19.2, 0.20.1
(the first published 0.20 release), 0.21.0, 0.22.0 and 0.23.0. Tests include
provider protocol calls, cancellation, errors, SSR imports and both TypeScript
module-resolution modes. Use Node.js 22.13 or newer with SDK 0.23.

This adapter is for the external provider host. New LO-native applications use
`createLoClient` from `@lo-ink/miniapp-sdk` directly.
