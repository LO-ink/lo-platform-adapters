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

Every request is a single POST to `/bot<TOKEN>/<method>`. Redirects are refused because the credential is in the path. The transport never retries, never includes credential URLs in errors, preserves decimal identifiers as strings, and forwards cancellation to `fetch`.

`HttpBotError` exposes the canonical SDK error `code`, HTTP `status`, upstream `platformCode`, and optional `retryAfterSeconds`. Messages are intentionally generic. Version 0.3 adds a bounded, sanitized
`BadRequest.description` for decisions such as invalidating a cached file ID.

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

See the [reference bot](../../examples/secretary/README.md) for durable polling,
authenticated webhooks, owner/chat isolation, replay, revoke and opt-in. These are LO-native secretary operations.

## Media, keyboards and errors (0.3.0)

Use bot-sdk 0.3.0. The transport builds exact Bot API JSON for `replyMarkup` and
`setChatMenuButton`, and multipart for uploaded photo/document/voice inputs. It
lets fetch set the multipart boundary; `reply_markup` is a JSON string. Streams
are bounded before any network request and cancelled with the request signal.
File IDs are reused as JSON; photo results select the final largest size.

API failures are SDK `RateLimited`, `NotAllowed`, `BadRequest` or `Unavailable`
instances, also instances of the existing `HttpBotError` export. Existing codes
and retryAfterSeconds remain compatible; RateLimited adds retryAfterSec.
BadRequest.description is bounded and redacts credentials and URLs. No implicit
retry exists. Voice upload uses AAC/M4A/MP4; voice captions and media URLs fail
before fetch. See bot-sdk's README for limits and cache invalidation.

## Files and video (0.4.0)

The transport supports native video uploads with upload-only metadata and thumbnail, cached audio, homogeneous photo/document albums, `getFile`, and bounded streaming downloads. Media sends use inline keyboards. Albums carry one LO message ID shared by all returned items; deleting that ID deletes the album.

Video calls allow a 90-second preparation deadline by default. Explicit client or per-call deadlines take precedence. File downloads use authenticated paths, reject redirects and traversal, and accept a persistent `signal`; consume or cancel the returned stream. Missing file paths remain absent.

A genuine API 429 refusal sets `details.safeToRetry`; unknown HTTP failures do not. Use the native SDK's explicit `retryRejected` only with replayable input. Network failures and 5xx sends are never repeated automatically.

Native keyboard values in bot-sdk 0.4 use camelCase. The transport converts them to the server contract and checks the serialized keyboard size before fetch. See bot-sdk’s upgrade note before updating 0.3 applications.
