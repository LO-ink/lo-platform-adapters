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

Structured server failure parameters are exposed as lo_reason and lo_parameter on aiogram exceptions. Non-JSON HTTP 5xx responses become TelegramServerError without exposing HTML diagnostics. Secretary requests with business_connection_id are rejected locally; use the native Bot SDK with LO consent context.

The packaged contract describes accepted requests. Tests run real aiogram clients against the strict LO emulator; the emulator does not reproduce production storage, authentication, transcoding or permissions.
