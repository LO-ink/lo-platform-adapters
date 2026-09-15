# aiogram compatibility

The pinned aiogram client runs against a local HTTP recorder. Tests cover method
routes, command serialization, multipart uploads, file downloads and typed API
errors. They do not authenticate against a deployed LO server or establish full
Bot API coverage.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -v
```

Configure the method and file roots together using the library's
[custom API server support](https://docs.aiogram.dev/en/latest/api/session/custom_server.html):

```python
import os

from aiogram import Bot
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer

bot = Bot(
    token=os.environ["LO_BOT_TOKEN"],
    session=AiohttpSession(
        api=TelegramAPIServer.from_base("https://api.lo.ink"),
    ),
)
```

Keep the token on the backend. Close the session with
`await bot.session.close()` when the application stops. The library adds the
`/bot<TOKEN>/<method>` and `/file/bot<TOKEN>/<path>` prefixes; the configured root
must not contain them. Test credentials are synthetic, and tests never poll a
shared bot.
