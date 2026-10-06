# Choosing an integration

| Application                               | Integration                                               |
| ----------------------------------------- | --------------------------------------------------------- |
| New LO mini-app                           | Core SDK and native LO adapter                            |
| LO mini-app on a WebApp host              | Explicit legacy LO adapter                                |
| LO SDK application running in Telegram    | Telegram host adapter                                     |
| Telegram WebApp application running in LO | Inbound Telegram-to-LO bridge                             |
| Existing aiogram bot running in LO        | LO HTTP session; handle unsupported operations explicitly |

Choose the provider in the application's composition root. Components receive a client with negotiated capabilities. The native adapter never switches to a compatibility transport after an unavailable or failed operation.

Install published packages from the lockfile, compile actual application call sites, and test packed artifacts through public exports. Verify signed launch data on the backend using the actual provider's key; preserve the signed bytes.

Before rollout, exercise required features on the target host, including permission denial, disposal, cancellation, delayed responses, theme changes and reload. Capabilities describe the current host rather than promised platform parity.
