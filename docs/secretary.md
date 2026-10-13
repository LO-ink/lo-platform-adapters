# Secretary operations and recovery

Start with the [owner-consent guide](https://github.com/LO-ink/lo-developer-tools/blob/main/docs/secretary.md).
Use the [typed final-send example](../examples/secretary-approved-reply.ts) only
after the bot authenticates approval of an exact persisted proposal and atomically
claims it. An owner ID alone is not approval. AI proposals and their approval
belong to the bot; LO retains exact templates, schedules, chat scope and rights.
The [old native-review runnable](../examples/secretary) is retired and stops
before network or state I/O. Never convert its old jobs into sends.

SDK 0.6.0 removes the native proposal method. Earlier versions or transitional
server contracts may still list it; that does not make it a supported new flow.
The HTTP adapter peer-range upgrade follows the coordinated SDK/server release.

## Transport operations

| SDK operation    | LO HTTP method                                     | Purpose                                                                         |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `getConnection`  | `getBusinessConnection`                            | Inspect the connection accessible to this bot                                   |
| `sendText`       | `sendMessage` with business connection/context     | Send directly under independently granted rights                                |
| `sendMedia`      | `sendBusinessMedia`                                | Send scoped media file IDs                                                      |
| `editText`       | `editMessageText` with business connection/context | Edit a permitted delegated reply                                                |
| `markRead`       | `readBusinessMessage`                              | Mark read only under its separate right                                         |
| `deleteMessages` | `deleteBusinessMessages`                           | Delete authorized messages; `deleteAll` requires its separate destructive right |
| `getFile`        | `getFile` with scoped secretary descriptor         | Obtain a bounded, expiring media download                                       |

Parameter availability comes from [contract.json](../packages/bot-http-lo/contract.json).
The transport translates decimal-string IDs and the delivered context. It does
not authorize owner consent locally. Do not construct internal service requests,
substitute a peer ID for a conversation ID or treat a cached grant as permission.

## Failure fixtures

`test/secretary-reference.test.mjs` verifies that retired entry points refuse
without network, payload reads or changes to old state and locks.
`test/secretary-contract-fixtures.test.mjs` runs reusable synthetic wire fixtures
through the production lossless decoder and client. The fixtures use no real
account, token or private conversation data.

```sh
npm ci
npm run build
npm run check
node --test test/secretary-reference.test.mjs test/secretary-contract-fixtures.test.mjs
```

A local fixture proves serialization and failure handling, not deployed server
permissions. Run the full consent and excluded-chat matrix on staging before a
live rollout. Approval of a bot-owned proposal is authenticated and persisted by
the bot; native connection access alone does not approve a pending answer.

## Recovery rules

Persist an exact request before writing; reuse its ID, context and body after
uncertainty. Persist processing progress before advancing the poll offset or
acknowledging a webhook. Stop obsolete work after permanent denials or conflicts.
Respect quota delays without changing request identity. Keep unknown outcomes
visible until reconciled, including a client cancellation after server commit.

Confirm action-receipt snapshot retention and recovery windows for your deployed
backend; an SDK upgrade does not add server retention. An expired receipt never
authorizes a replacement request key. Canonical chat history has its own lifecycle.
Retain old native draft receipts separately; never replay them as bot-owned sends.
Logs and exports contain safe outcome codes and metadata, never message bodies,
media URLs, credentials or AI prompts.
