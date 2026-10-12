# Bot framework compatibility

These tests use exact versions of Telegraf and grammY against a loopback recorder. They verify request paths, JSON/multipart encoding, response parsing, file URLs and typed API errors. They do not authenticate against a deployed LO server and are not evidence that every Bot API method is implemented.

```sh
npm ci
npm test
```

The deployed LO method root is `https://api.lo.ink`. Configure `telegram.apiRoot` in Telegraf or `client.apiRoot` in grammY; the libraries add `/bot<TOKEN>/<method>`. Do not append `/bot` to the configured root. Keep tokens on the backend.

Reference contract: [the generated public API contract](../../contracts/lo-bot-api.json). Supported methods still require a deployed integration test with a dedicated bot. Shared bot polling is intentionally absent from this suite.
