# LO-native secretary reference bot

A text-only template bot, without AI. It demonstrates the SDK/HTTP boundary, not
a production hosting system. Bot capability and owner consent are prerequisites.
The owner chooses the chats and six independent rights in LO. Server policy is
checked again at delivery and every write.

## Run locally or on staging

Use Node 22+ and the matching SDK/HTTP adapter. From this repository:

```sh
npm ci
npm run build
# Set credentials through your secret manager or private environment, not source.
export LO_SECRETARY_STATE=/private/path/secretary/state.json
node examples/secretary/run.mjs
```

`LO_BOT_TOKEN` is required. `LO_BOT_API_URL` may select the HTTPS staging endpoint.
For a local fixture only, set `LO_ALLOW_LOOPBACK_HTTP=1` and a loopback HTTP URL.
Do not connect a fixture to production users. Poll mode owns the bot's one update
stream: remove its configured webhook first and run only one poller.

Every eligible incoming event produces a **review draft** through
`proposeBusinessDraft`. The owner approves or cancels it in LO. Auto replies are
**off by default**: only a separate owner-controlled rule for this connection
and chat can enable them. The server checks the exact greeting template, IANA
timezone, selected weekdays, hours and minimum interval on every send. Changing
connection permissions disables the previous automatic consent.

The fixed template is `Hello! Your message has been received. The owner will reply when available.` (one space after the comma; no newline). `LO_SECRETARY_AUTO_CHATS`
is an optional operator restriction: a JSON array of `connectionId` and `chatId`
strings. An empty array processes all chats allowed by the owner's policy. This
operator setting **never authorizes automatic sending**. The sample limits
proposals to one per minute per connection/chat. Owner messages and delegated
echoes are ignored. Missing text or unsupported/unavailable media proposes a
`cannot_answer` draft for owner review; that reason cannot auto-send.

For webhook mode, set `LO_SECRETARY_MODE=webhook` and `LO_WEBHOOK_SECRET` to a
random 32..128 character string from a secret manager. The listener binds
`127.0.0.1:8090` (override `PORT`). Terminate TLS at your configured ingress and
register that HTTPS `/secretary` URL and the same secret through the existing
Bot API `setWebhook` operation. The example does not register it automatically.
Every POST must carry `X-Telegram-Bot-Api-Secret-Token`; it is checked before reading
its body. Only JSON up to 2 MiB is accepted. Polling and webhook bodies use the
same lossless decoder, including IDs larger than JavaScript's safe integer.
Never feed an unauthenticated request directly into the reference processor.

## Durable processing

State is isolated by bot ID, opaque connection ID and peer chat ID. The state
file is private (0600), contains no credential or incoming text, and has a
single-process lock. Before proposing a draft, an atomic write and fsync persist the exact
request ID and context. After success, state is saved before advancing the poll
offset or acknowledging the webhook. If delivery succeeds but the response is
lost, replay retries the same proposal key and fixed text; server receipts prevent
a duplicate effect. Request keys also include bot/connection/chat so identical
event IDs in different owners' connections cannot collide.

A connection update cancels pending jobs on pause/revoke or version change.
Source edit/delete cancels pending work; this sample does not rewrite previously
sent replies. Forbidden, stale/conflict or unsupported actions stop that
connection's pending work. New connection IDs require fresh owner consent and a new automatic rule. A pending
job expires after 24 hours; terminal event receipts retain only IDs for seven
days. Limits are 256 connections and 10,000 retained events; reaching a limit
stops processing instead of silently deleting a live deduplication record.

Graceful SIGINT/SIGTERM closes the lock. After a crash, verify that the PID in the
`.lock` file no longer runs before removing that lock; do not delete the state.
Run one process. Multi-worker production deployment needs a transactional shared
store and coordinated update ownership. Keep the state directory private and
back it up under the same retention rules. Logs contain status codes only.

## Verification and pilot checklist

```sh
node --test test/secretary-reference.test.mjs
npm test
```

Local tests cover owners A/D, separate chat scopes, restart/replay, uncertain
committed proposals and server-authorized automatic sends, source edit/delete, revoke/forbidden and no reply loops. Test the
same paths on staging with two test owners and a third excluded chat, then revoke
while a response is pending. Staging execution and production release require
the matching deployed secretary backend; local fixtures do not prove deployment.

This is LO-native delegation. Familiar business API names do not grant Telegram
accounts, history export, profile/stories access, financial permissions or AI.
