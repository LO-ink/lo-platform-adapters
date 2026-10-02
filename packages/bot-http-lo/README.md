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

## Secretary extension (0.2)

The transport also implements `SecretaryTransport` for
`createSecretaryClient(transport)`. Business events returned by `getUpdates` are
normalized to the SDK's secretary union; ordinary bot calls keep their existing
wire behavior. `parseLoBotWebhookUpdate(rawBody)` uses the same decoder and
preserves 64-bit IDs. Authenticate the webhook secret before calling it; parsing
alone never authenticates a request. `decodeLoBotUpdate` accepts an already parsed
object, whose unsafe numeric IDs are rejected rather than rounded.

Connection IDs, source context and stable request keys scope every delegated
write. Context identifiers and bulk message IDs are serialized as decimal strings;
credential generation and owner identity are derived by the server, never from
caller-provided grant fields. Receiving, reading, sending and deleting remain
independent. `deleteAll` is explicit and requires its separate owner permission.

See the [no-AI reference bot](../../examples/secretary/README.md) for durable polling,
authenticated webhooks, owner/chat isolation, replay, revoke and opt-in. These are
LO-native extensions, not a Telegram account connector.
