# `@lo-ink/bot-http-lo`

Server-side HTTP transport for `@lo-ink/bot-sdk` and the LO Bot API.

```ts
import { createBotClient } from "@lo-ink/bot-sdk";
import { createLoHttpBotTransport } from "@lo-ink/bot-http-lo";

const transport = createLoHttpBotTransport({
  token: process.env.LO_BOT_TOKEN!,
});
const bot = createBotClient(transport);

const identity = await bot.getIdentity();
await bot.sendMessage({
  conversationId: "9007199254740993",
  text: `Hello from ${identity.name}`,
});
```

The default endpoint is `https://api.lo.ink`. A custom endpoint must use HTTPS. Tests may explicitly enable plain HTTP for an exact loopback host:

```ts
createLoHttpBotTransport({
  token: "1:test-token",
  baseUrl: "http://127.0.0.1:8080",
  allowInsecureLoopback: true,
});
```

Every request is a single POST to `/bot<TOKEN>/<method>`. Redirects are refused because the credential is in the path. The transport never retries, never includes upstream response text or URLs in errors, preserves decimal identifiers as strings, and forwards cancellation to `fetch`.

`HttpBotError` exposes the canonical SDK error `code`, HTTP `status`, upstream `platformCode`, and optional `retryAfterSeconds`. Messages are intentionally generic and safe to log.
