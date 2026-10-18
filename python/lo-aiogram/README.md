# lo-aiogram

LO HTTP session for aiogram 3.31–3.x. The session serializes aiogram methods for LO and preserves requested operations and errors.

```python
import os
from aiogram import Bot
from lo_aiogram import LoAiohttpSession

bot = Bot(os.environ["LO_BOT_TOKEN"], session=LoAiohttpSession())
```

Close the session when the bot stops. Use HTTPS for custom base_url. Tests may explicitly allow loopback HTTP. Single files and thumbnails use parameter-named parts; album files use attach:// references.

Unsupported fields, mixed albums, disabled video uploads and unimplemented methods fail explicitly. The adapter never strips fields, changes a video into a document, splits an album, retries a mutation or returns success for an unsupported operation. Existing Telegram handlers must be adapted to the documented LO contract. Read installation capabilities explicitly through getMe when needed.

## Explicit compatibility for existing Telegram handlers

Opt in at the composition root; importing this module does not change any bot:

```python
from aiogram import Bot
from lo_aiogram import LoAiohttpSession, capabilities
from lo_aiogram.compat import LoBotCompat

session = LoAiohttpSession()
session.middleware(LoBotCompat())
bot = Bot(os.environ["LO_BOT_TOKEN"], session=session)
flags = await capabilities(bot)
```

`LoBotCompat` uses the packaged contract to omit unsupported method fields and upload-only video metadata when sending a cached `file_id`. It logs each method/omission once per middleware instance, using names rather than request values. Existing `message.reply(...)` calls can therefore run even when aiogram supplies `reply_parameters` and `disable_notification`. This loses the requested reply/silent effects: it does not implement them in LO. Native secretary/consent fields are rejected before omissions.

An explicit `feature_disabled` refusal for an uploaded video can fall back to `sendDocument`, preserving supported caption and keyboard parameters. Contiguous photo or document runs remain albums; video items are sent individually, in original order. A singleton or an item with its own later caption is sent separately. Unsupported album types are rejected before sending. These parts are not atomic: `PartialDeliveryError.completed` contains acknowledged messages and `__cause__` the failing request. Cancellation remains `CancelledError`, with a `completed` tuple of acknowledged parts. An interrupted request may also have an unknown delivery outcome. Never automatically repeat the original album.

Only a structured `sendChatAction` 501 (`method_not_implemented`) becomes a local `True` no-op, remembered for that transport until a new middleware/session is created; other failures remain failures. At most one retry per request is permitted after a matching HTTP/envelope 429 carrying the explicit boolean `parameters.safe_to_retry: true`, with `retry_after` between 0 and 60 seconds. The current public LO contract does not promise this marker: an ordinary production 429, timeout, network error or 5xx is **not** retried. The emulator's preparation refusal supplies the marker to test the safe branch; this is a fixture guarantee, not evidence of a deployed server guarantee.

Fallback/retry requires repeatable data: cached IDs, `BufferedInputFile`, or `FSInputFile`. Keep filesystem bytes unchanged until the operation completes. Custom/URL `InputFile` streams are never replayed automatically; a video fallback for them propagates the original error. Close the session normally when the bot stops.

## Installation capabilities

`await capabilities(bot)` returns a copied dictionary of flags such as `video_uploads`, `audio_uploads`, `media_groups` and `chat_actions`. Missing flags remain absent, not false. Reads coalesce and are cached for five minutes per bot/session instance; `refresh=True` forces a new read. A structured `feature_disabled` refusal invalidates the cache in the strict session too, so the next read refreshes it. Older in-flight reads cannot overwrite a newer refresh or invalidate that refusal. Flags describe installation features, not authorization.

## Local and container CI

Plain HTTP is accepted only with explicit `allow_insecure_loopback=True` and the literal host `127.0.0.1`, `localhost` or `::1`. A container service name such as `http://emulator:8080` is intentionally refused. Keep the bot and emulator in a shared network namespace (`docker run --network container:<emulator-container> ...`) and connect to `http://127.0.0.1:8080`, or use HTTPS. Do not broaden transport security to make a test pass. Use synthetic tokens in the unauthenticated emulator.

Structured server failure parameters are exposed as lo_reason and lo_parameter on aiogram exceptions. HTTP 5xx responses become TelegramServerError without exposing server diagnostics. Redirects are refused. Network and malformed-response exceptions expose no authenticated URLs or raw response bodies; typed API errors redact the configured bot credential while preserving retry, migration and LO refusal metadata. Successful response data is unchanged. Secretary requests with business_connection_id are rejected locally; use the native Bot SDK with LO consent context.

The packaged contract describes accepted requests. Tests run real aiogram clients against the strict LO emulator; the emulator does not reproduce production storage, authentication, transcoding or permissions.
