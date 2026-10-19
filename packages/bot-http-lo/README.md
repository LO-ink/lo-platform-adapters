# `@lo-ink/bot-http-lo`

Compatibility exports for the HTTP transport in `@lo-ink/bot-sdk`. Version 0.9
requires SDK `^0.7.0`; upgrade both packages together. New bots install only the
SDK and call `createLoBotClient`.

Existing applications can keep their transport imports:

```ts
import { createBotClient } from "@lo-ink/bot-sdk";
import { createLoHttpBotTransport } from "@lo-ink/bot-http-lo";

const token = process.env.LO_BOT_TOKEN;
if (!token) throw new Error("LO_BOT_TOKEN is required");
const bot = createBotClient(createLoHttpBotTransport({ token }));
await bot.sendMessage({ conversationId: "9007199254740993", text: "Hello" });
```

The exports `createLoHttpBotTransport`, `decodeLoBotUpdate`,
`parseLoBotWebhookUpdate` and `HttpBotError` are aliases of the SDK implementation;
this package adds no transport state. See the
[Bot SDK](https://github.com/LO-ink/lo-bot-sdk#readme) for supported methods, media
limits, reply/silent options, chat actions, errors and cancellation.

The default API root is `https://api.lo.ink`. Custom roots require HTTPS; tests
may explicitly allow HTTP for `127.0.0.1`, `localhost` or `::1`. Requests preserve
64-bit identifiers, refuse redirects and never retry implicitly. Authenticate
webhooks before parsing them; neither decoder authenticates a caller.

The transport also implements the SDK's secretary extension. Connection consent
and exact source context remain server-enforced; an owner ID or cached connection
is not authorization. Bot-owned proposals require authenticated approval and a
persisted request ID/context/body before sending. Never replay retired native
proposal jobs. See the
[secretary guide](https://github.com/LO-ink/lo-developer-tools/blob/main/docs/secretary.md).

`@lo-ink/bot-http-lo/contract` exports the server-generated API contract, including
methods outside the typed SDK surface. Generation verifies committed server
source and rejects dirty source before export; private source provenance is
omitted. This contract does not identify or qualify a deployed server.
