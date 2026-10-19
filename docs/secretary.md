# Secretary operations and recovery

Start with the [owner-consent guide](https://github.com/LO-ink/lo-developer-tools/blob/main/docs/secretary.md).
The [typed send example](../examples/secretary-approved-reply.ts) is the final
step after the bot authenticates approval of an exact persisted proposal and
atomically claims it. Connection access or an owner ID alone is not approval.
Native proposal APIs are retired; [old entrypoints](../examples/secretary) stop
before network or state I/O. Preserve their state and never convert old jobs into
sends. LO retains exact templates, schedules, chat scope and independent rights.

## Operations

| SDK operation    | LO HTTP method                          | Purpose                                                            |
| ---------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `getConnection`  | `getBusinessConnection`                 | Inspect this bot's connection                                      |
| `sendText`       | `sendMessage` with business context     | Send a permitted delegated reply                                   |
| `sendMedia`      | `sendBusinessMedia`                     | Reuse scoped source-media IDs                                      |
| `editText`       | `editMessageText` with business context | Edit a permitted reply                                             |
| `markRead`       | `readBusinessMessage`                   | Exercise the separate read right                                   |
| `deleteMessages` | `deleteBusinessMessages`                | Delete permitted messages; `deleteAll` requires its separate right |
| `getFile`        | `getFile` with secretary descriptor     | Obtain an expiring media download                                  |

Use delivered decimal-string IDs and context exactly. Do not substitute peer IDs
for conversation IDs or use cached connection data to authorize a write.
Parameter availability is defined by [the contract](../packages/bot-http-lo/contract.json).

## Recovery

Persist the exact request ID, context and body before writing; reuse them after
an uncertain result. Cancellation can occur after server commit. Respect quota
delays, stop obsolete work after permanent denials/conflicts, and keep unknown
outcomes visible until reconciled. An expired receipt never authorizes a new
request key; check your backend's receipt retention and recovery windows.
Persist processing progress before advancing a poll cursor or acknowledging a
webhook. Logs contain safe outcome metadata, not message bodies, media URLs,
credentials or AI prompts.

Local decoder and retired-entrypoint tests use synthetic data. They verify wire
shapes and failure handling; exercise consent and excluded-chat cases on staging
before a live rollout.
