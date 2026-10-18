# LO Bot API emulator

A local request-contract fixture for bot migrations. It loads the same generated manifest as the LO HTTP transport and `lo-aiogram`; it rejects unknown fields, stubbed methods, invalid upload references, upload-only metadata on cached videos, and unsupported albums.

Modeled edits and deletions require valid int64 targets; callback answers require a query ID. Keyboard objects must have a modeled shape. Album items resolve their own exact attachment references, including parts named `photo` or `document`. Malformed caption structures receive a JSON 400 refusal, and refused requests do not commit synthetic assets or advance message IDs. These checks validate request inputs; they do not prove a target exists or that a caller is authorized to modify it.

```sh
pip install lo-bot-api-emulator
lo-bot-api-emulator --port 8080
lo-bot-api-emulator --disable-video-uploads --legacy-single-attach
```

Use synthetic tokens and media fixtures. The emulator does not authenticate credentials, transcode video, validate media contents or reproduce storage, permission checks and production rate limits. Unmodeled implemented methods explicitly return 501; they never receive a generic successful response. The CLI binds to `127.0.0.1` by default. Use `--host` only for an explicitly isolated test network; the container command selects `0.0.0.0` inside its network while the example publishes only a loopback host port.

The Dockerfile belongs to the [source repository](https://github.com/LO-ink/lo-platform-adapters/tree/main/python/lo-bot-api-emulator); it is not included in installed wheels or source distributions. To build locally, clone the repository and run Docker from the emulator source directory:

```sh
git clone https://github.com/LO-ink/lo-platform-adapters.git
cd lo-platform-adapters/python/lo-bot-api-emulator
docker build -t lo-bot-api-emulator .
docker run --rm -p 127.0.0.1:8080:8080 lo-bot-api-emulator
```

The Python API exposes `LoBotApiEmulator.requests`: the last 1000 method, field-name, file-part-name and status records. It retains no tokens or request text. Request content is limited to 512 MiB and 32 multipart parts, including aggregate file and text payload bytes; individual text fields are limited to 64 KiB. The synthetic asset store retains at most 100 assets and 512 MiB; new uploads receive a JSON 507 refusal at capacity, preserving existing assets and message IDs. Set `request_bytes`, `asset_bytes`, `max_assets`, `max_history` and `max_parts` on `LoBotApiEmulator` for smaller test budgets. These are fixture limits, not production authorization or a whole-process memory guarantee. `video_retry_count` provides deterministic preparation refusals for retry tests.

Regenerate the contract from a checked-out server revision using the repository's `scripts/generate-bot-contract.mjs`. `--check` compares all packaged copies without modifying them. CI executes unchanged aiogram handlers and Telegraf/grammY clients against this fixture, including a negative test that removes compatibility middleware.

Generation verifies the contract against committed server source and refuses dirty source. Private provenance is checked before export and is not included in distributions. The public contract describes verified request and response shapes; it does not identify or qualify a deployed server.

Document albums require distinct cached file references. The fixture models the observed core refusal for duplicate document IDs; newly uploaded items create distinct synthetic assets.

## Incoming updates and bot CI

Queue exact synthetic payloads with `await emulator.enqueue_update(update, token=synthetic_token)`. Supported update kinds are `message`, `callback_query` and `inline_query`. Supply the complete payload your handler expects; the fixture never invents user names, language or permissions. IDs are assigned monotonically unless a newer explicit `update_id` is supplied. Queues are isolated by token (stored as hashes), retain at most 1000 updates per bot and 16 bots by default, and disappear on restart. Each update is limited to 64 KiB; `max_updates` and `max_bots` configure smaller CI budgets.

`getUpdates` supports limit, offset acknowledgements, negative tail offsets and persistent `allowed_updates`. Empty calls wait for the requested integer timeout (0–50 seconds), waking when a matching update arrives. Returned updates remain available until acknowledged by offset; consumers must handle redelivery. A webhook and polling are mutually exclusive (409); a second active poll for the same token also receives 409 without changing the first poll’s filter.

For a bot in another process, explicitly start the isolated fixture with `--enable-control`. POST `{ "token": "<synthetic token>", "update": { "message": { ... } } }` to `/__fixture/updates`; the response returns its update ID. The endpoint is disabled by default and has a 64 KiB body limit. Never expose this unauthenticated test control to a production network or use real bot credentials.

`setWebhook` stores the URL, secret and update filter. Matching queued updates are POSTed with `X-Telegram-Bot-Api-Secret-Token`. Only 2xx acknowledges/removes an update; failure, timeout and redirect retain it. Delivery is serialized per bot, without a background retry loop. Enqueueing another update, setting a webhook, `await emulator.deliver_updates(token=token)`, or POSTing `{ "token": "<synthetic token>" }` to `/__fixture/deliver` explicitly attempts pending delivery. `getWebhookInfo` reports pending count; `deleteWebhook(drop_pending_updates=True)` clears the queue. Destination HTTPS is required; local webhook tests may explicitly set `allow_insecure_loopback_webhooks=True` / `--allow-insecure-loopback-webhooks` for literal loopback HTTP. This is a deterministic delivery fixture, not a model of production retry schedules, authentication or exactly-once delivery.

## Disk journal and verdict

Start with `--journal /writable/requests.jsonl` (or `journal=Path(...)`). The append-only JSONL file records method/field names, status, update IDs and delivery status. Unknown field, method and attachment names are replaced with placeholders; tokens, URLs, text, callback data, language, filenames and bytes are omitted. New files use mode 0600. CLI HTTP access logging is disabled to keep token-bearing request paths out of logs. If embedding `app()` in another runner, also set `access_log=None`. Keep the output directory writable by container UID 10001, use a fresh file for each CI run, and archive/remove it with your normal CI artifacts policy. The journal is metadata, not durable message storage or a whole-process secrecy guarantee.

```sh
lo-bot-api-emulator --port 8080 --enable-control --journal ./requests.jsonl
# Run a polling bot and enqueue /start, a button callback, or an inline query.
lo-bot-api-emulator verdict ./requests.jsonl --require-response \
  --require-method editMessageReplyMarkup --require-method answerCallbackQuery
```

The verdict exits 0 only for a readable, nonempty, valid journal with no refused requests and all requested successful methods. `--require-response` requires an acknowledged send. A missing, empty, malformed or refused journal exits 1. Expected negative probes remain refusals even when compat handled them; review and allow only exact pairs, e.g. `--allow-refusal sendChatAction:501`. A successful fixture send is not proof of production delivery or that a user saw the message.

The journal works across container boundaries: keep it on a shared writable volume, or use `docker exec <emulator> lo-bot-api-emulator verdict <path> ...` and `docker cp <emulator>:<path> ./requests.jsonl`. `lo-aiogram` permits explicit HTTP only on literal loopback hosts; the bot container must use `--network container:<emulator>` with base URL `http://127.0.0.1:8080`, or HTTPS. A service-name HTTP URL is refused intentionally.

## Modeled method inventory

`lo-bot-api-emulator --methods` prints the manifest's current modeled/unmodeled inventory without starting a server. In addition to sending media/text, the fixture models `editMessageText`, `editMessageCaption`, **`editMessageReplyMarkup`**, callback/inline answers, polling and webhook configuration. Edit responses contain synthetic IDs and the supplied text/caption/inline keyboard; original message content, target existence and permissions are not reconstructed.

Implemented LO methods still returning an explicit emulator 501 are:
`answerWebAppQuery`, `banChatMember`, `copyMessage`, `deleteBusinessMessages`,
`forwardMessage`, `getBusinessConnection`, `getChat`, `getChatMember`,
`getChatMemberCount`, `getChatMenuButton`, `getMyDescription`, `getMyName`,
`getMyShortDescription`, `promoteChatMember`, `readBusinessMessage`,
`savePreparedInlineMessage`, `sendBusinessMedia`, `sendContact`, `sendMessageDraft`,
`setMyDescription`, `setMyName`, `setMyShortDescription`, `unbanChatMember`.

Methods marked unimplemented in the contract still return their native 501. The deterministic video preparation 429 includes `safe_to_retry: true` because this fixture has not committed a message or asset; the public production contract does not promise that extension. A compatibility client must not infer safe retry from `retry_after` alone.

## Container releases

The main-only **Publish emulator container** workflow builds a Linux amd64 image from the digest-pinned Dockerfile after Python source, wheel and strict bot-client checks. It starts that exact image using its default command on an ephemeral loopback port, checks synthetic identity, invalid-parameter and stub refusals, installed version and non-root execution, then pushes the same image to `ghcr.io/lo-ink/lo-bot-api-emulator` with version and `sha-<full-commit>` tags. The publisher refuses either existing version or commit tag; authentication, transport and unrecognized registry errors fail closed. There is no force override. Workflow concurrency serializes this publisher; registry administrators must also avoid external writes to release tags during publication. The release artifact records the image ID, registry digest, source revision and smoke results. A receipt is saved immediately after each successful push, so a failed second tag still leaves evidence of the first published digest and fails the job. Ordinary CI runs the same container smoke after its Docker build.

After `make python-install`, run the smoke locally from the repository root with `python scripts/check-emulator-container.py lo-bot-api-emulator`. It also runs a real aiogram polling/reply/button flow against a configured instance of that image and checks the on-disk journal inside the container. It uses synthetic input and removes only the container it started.

This workflow uses the repository's `GITHUB_TOKEN`; no Docker Hub credentials are needed. A new GHCR package is private by default. Publication does not establish public availability: an owner must separately enable public visibility and verify an anonymous pull of the recorded digest before announcing a public image. No image is claimed published merely because this workflow exists. The pinned base does not make rebuilds deterministic: Python build and runtime dependencies still use version ranges. Use the recorded registry digest to identify an actual release.
