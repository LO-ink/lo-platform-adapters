# Choosing an integration

| Application                               | Integration                                               |
| ----------------------------------------- | --------------------------------------------------------- |
| New LO mini-app                           | Mini App SDK `createLoClient`; no adapter package         |
| LO mini-app on a WebApp host              | Explicit legacy LO adapter                                |
| LO SDK application running in Telegram    | Telegram host adapter                                     |
| Telegram WebApp application running in LO | Inbound Telegram-to-LO bridge                             |
| Existing aiogram bot running in LO        | LO HTTP session; handle unsupported operations explicitly |

New LO integrations use the [Mini App SDK](https://github.com/LO-ink/lo-miniapp-sdk) directly. The other rows describe existing integrations maintained outside the native quickstart. Choose their provider explicitly in the application's composition root. Components receive a client with negotiated capabilities. Native requests never switch to a different transport after an unavailable or failed operation.

Install published packages from the lockfile, compile actual application call sites, and test packed artifacts through public exports. Verify signed launch data on the backend using the actual provider's key; preserve the signed bytes.

Before rollout, exercise required features on the target host, including permission denial, disposal, cancellation, delayed responses, theme changes and reload. Capabilities describe the current host rather than promised platform parity.
