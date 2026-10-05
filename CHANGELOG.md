# Changelog

## adapter-lo 0.23.2

- Use current snapshots from native LO ports advertising optional `liveSnapshot`, including across periods with no event subscriptions. Preserve event overlays for older launch-snapshot ports.
- Ignore missing inset event payloads instead of delivering `undefined` to typed listeners.
- Document and test the native LO 60-second deadline, including callers with longer SDK deadlines.
- Map hidden-host `ABORTED` and `NOT_AVAILABLE` failures to existing SDK error codes.
- adapter-lo-legacy 0.1.3 pins adapter-lo 0.23.2 so its native re-export and composed hosts receive these fixes.

## Coordinated SDK feedback release

- adapter-lo 0.23.0: display-only launchUnsafe and typed NO_BOT, with old-host compatibility tests.
- bot-http-lo 0.3.0: keyboard/menu serialization, multipart photo/document/voice uploads, bounded streams, fileId reuse and SDK error classes.
- Compatibility packages receive patch updates for miniapp-sdk 0.20.0 and adapter-lo 0.23.0 peer support.
- Cancel rejected upload streams and release their reader locks; validate inferred voice Blob MIME consistently with the Bot SDK.
- Existing errors, secretary operations and no-retry semantics remain compatible.

Native adapter 0.23 and its legacy composition require miniapp-sdk 0.20. Bot HTTP
0.3 requires bot-sdk 0.3 because these releases import the new typed helpers.
Compatibility-only adapters continue supporting their declared older peers.
