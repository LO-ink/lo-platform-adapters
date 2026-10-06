# LO and Telegram API differences

Use the packaged LO contract and runtime capabilities to determine support.

| Topic                                  | Telegram                    | LO                                                                                          |
| -------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| sendPhoto URL input                    | HTTP(S) URLs                | Multipart upload or this bot's file_id; the SDK rejects URLs before sending                 |
| sendVoice format                       | OGG/Opus                    | AAC in M4A/MP4 or raw AAC; the server checks content                                        |
| sendVoice caption                      | Supported                   | Rejected by the SDK                                                                         |
| Upload sizes                           | Method-dependent            | Photo ≤ 10 MiB; document and voice ≤ 50 MiB                                                 |
| Photo/document caption                 | Up to 1024 characters       | Up to 1024 UTF-16 units; an emoji can occupy two                                            |
| language_code                          | Usually the client language | May be empty or differ from the UI; send the app's selected reminder language to the server |
| Audio before a gesture                 | Client/WebView-dependent    | Some hosts require a gesture; handle playback refusal explicitly                            |
| Write access without an associated bot | Context-dependent           | Older hosts return false; updated hosts return NO_BOT → NoBot                               |
| Registered app signature key           | Usually bot-token HMAC      | The app key string from LO Connect; validate app_id                                         |
| Mini-app button URL                    | Bot configuration-dependent | Must match LO Connect byte for byte for a signed launch                                     |

Check client.supports(...), then handle unsupported operations and permission denial. Platform names and version numbers alone do not establish support.

See [messages from a mini-app](https://github.com/LO-ink/lo-developer-tools/blob/main/docs/miniapp-pushes.md) and [audio lifecycle](https://github.com/LO-ink/lo-developer-tools/blob/main/docs/miniapp-audio.md).
