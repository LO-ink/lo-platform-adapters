# `@lo/adapter-telegram`

Adapter for Mini Apps running inside Telegram. `createAdapter()` performs synchronous discovery. `loadAdapter()` optionally loads Telegram's official browser script once with a bounded timeout and removes the script node afterward.

The returned `TelegramMiniAppAdapter` also exposes provider-only `telegram.requestChat`, `telegram.setEmojiStatus`, and `telegram.openTelegramLink` extensions. These do not enter the portable LO operation map.

```ts
import { loadAdapter } from "@lo/adapter-telegram";

const adapter = await loadAdapter();
```
