# Changelog

## Coordinated SDK feedback release

- adapter-lo 0.23.0: display-only launchUnsafe and typed NO_BOT, with old-host compatibility tests.
- bot-http-lo 0.3.0: keyboard/menu serialization, multipart photo/document/voice uploads, bounded streams, fileId reuse and SDK error classes.
- Compatibility packages receive patch updates for miniapp-sdk 0.20.0 and adapter-lo 0.23.0 peer support.
- Existing errors, secretary operations and no-retry semantics remain compatible.

Native adapter 0.23 and its legacy composition require miniapp-sdk 0.20. Bot HTTP
0.3 requires bot-sdk 0.3 because these releases import the new typed helpers.
Compatibility-only adapters continue supporting their declared older peers.
