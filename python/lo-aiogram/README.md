# lo-aiogram

LO session and request middleware for aiogram 3.31–3.x. Compatibility translations live in this package; the native LO SDK has no aiogram dependency.

```python
import os
from aiogram import Bot
from lo_aiogram import LoAiohttpSession

bot = Bot(os.environ["LO_BOT_TOKEN"], session=LoAiohttpSession())
# Existing message.reply(), reply_video() and reply_media_group() handlers stay intact.
```

Close the session when the bot stops. Use HTTPS for custom `base_url`; only tests may explicitly set `allow_insecure_loopback=True` for loopback HTTP. Single files and thumbnails use parameter-named parts, including on older LO installations. Album files use `attach://` references.

The middleware reads the packaged server contract. It omits unsupported fields and logs each omission once, without credentials. Cached video IDs lose upload-only metadata. The first video call reads installation capabilities from `getMe`, and refreshes them on subsequent video calls after five minutes. A known disabled upload goes directly to a document. Older installations without capabilities use a five-minute cache after the first explicit refusal, then probe the video method again. A video preparation 429 gets one bounded wait and repeat; another 429 sends a document without disabling future video uploads. Files used for these explicit fallbacks must be replayable (`BufferedInputFile` or `FSInputFile`); a consumed custom producer cannot be reconstructed.

A rejected mixed album is split in order into homogeneous photo/document groups and individual videos. This creates several messages, so partial delivery is possible if a later send fails. Other sends, timeouts and network failures are never retried. Upload requests do not take the generic unsupported-field retry. The middleware returns aiogram results, including the actual document when video falls back.

LO currently has no typing action. The first exact `sendChatAction` 501 logs an omission; subsequent calls return `True` locally. This means compatibility handling completed, not that a typing indicator appeared. Other 501 errors propagate. HTTP 5xx responses without a valid API envelope become `TelegramServerError` with no HTML detail.

To control or reset learned installation limits:

```python
from lo_aiogram import LoBotApiCompat

compat = LoBotApiCompat(feature_ttl=300, max_video_retry_after=30)
session = LoAiohttpSession(compatibility=False)
session.middleware(compat)
bot = Bot(os.environ["LO_BOT_TOKEN"], session=session)
compat.reset(bot)  # after an installation upgrade or configuration change
```

Caches are isolated by API endpoint and credential. Structured failure reasons take precedence over legacy description matching. Set `probe_capabilities=False` only when the application handles installation discovery itself. Secretary operations with `business_connection_id` are rejected locally: use the native SDK with explicit LO consent context. They must never silently become ordinary bot sends.

The bundled contract records its source commit. It describes accepted requests, not storage, chat permissions, production rollout or installation flags. Conformance tests use the strict LO emulator; live acceptance remains a separate check.

Contract provenance is checked against Git source digests. Local verification may use `--allow-working-tree`; its manifest has `source.commit: null`, an explicit base commit and source fingerprint. Such a fixture is unreleased and does not identify a deployed server revision.
