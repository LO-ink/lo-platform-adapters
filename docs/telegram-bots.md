# Moving an existing Telegram bot to LO

## HTTP compatibility boundary

The LO HTTP compatibility service uses a method root of `https://api.lo.ink`.
Libraries construct `/bot<TOKEN>/<method>` and the file-download route from
that root. Use an LO-issued bot token and preserve the existing library's
update-processing model.

| Library                            | Configuration                        | Local compatibility evidence                                            |
| ---------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Telegraf 4.16.3                    | `telegram.apiRoot`                   | Actual client requests, JSON/multipart, files and errors                |
| grammY 1.46.0                      | `client.apiRoot`                     | Actual client requests, JSON/multipart, files and errors                |
| aiogram 3.31.0                     | `LoAiohttpSession` from `lo-aiogram` | Actual client requests, commands, uploads, files and errors             |
| python-telegram-bot / TelegramBots | Candidate integrations               | No compatibility claim until their own contract and deployed tests pass |

Changing the root is enough to redirect requests. It does not make every
Telegram method, update type, keyboard or payment flow available in LO. Audit
the methods used by the application and compare them with the deployed
service's support before switching production traffic.

For aiogram, use the [LO session and middleware](../python/lo-aiogram/README.md). Direct root replacement alone does not remove unsupported request fields or upload-only metadata; it is insufficient for unchanged handlers such as `message.reply`.

The [JavaScript library suite](https://github.com/lo-ink/lo-platform-adapters/tree/main/compatibility/bot-frameworks)
records the tested versions and configuration. The [Python suite](https://github.com/lo-ink/lo-platform-adapters/tree/main/compatibility/aiogram)
retains serialization checks. The [strict conformance suite](../python/tests) and [strict JavaScript suite](../compatibility/bot-frameworks/strict) use the server-generated LO contract, including negative requests. These fixtures do not reproduce production storage or permissions. Polling and webhook ownership must be coordinated
separately: do not start a second poller against a bot already serving users.
