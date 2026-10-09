# `@lo-ink/adapter-lo`

Compatibility exports for the native transport owned by `@lo-ink/miniapp-sdk`.
Version 0.24.2 supports SDK 0.22.2 and newer 0.22 releases, and SDK 0.23.
This package preserves existing imports; new applications use one package:

```ts
import { createLoClient } from "@lo-ink/miniapp-sdk";
const client = createLoClient();
if (!client) throw new Error("A supported LO host is required");
```

Existing `createAdapter`, `detectAdapter` and `createNativeAdapter` imports are
aliases of the SDK implementation. Native types remain exported. This package
contains no decoder or independent connection/request state.

Discovery returns `null` for an absent or invalid port. Capabilities are the
intersection of operations implemented by the SDK and the features
explicitly advertised by the host. Unknown host features are ignored. A failed
native request is never replayed through another transport.

The adapter validates envelope size, protocol version, document generation,
request identity, response shapes, theme values and event payloads. Requests
have bounded lifetimes and concurrency. Cancellation emits a single cancel
message; stale document results cannot settle a current request.

The supported protocol includes chrome, appearance, fullscreen, orientation,
haptics, popups, links, inline queries, clipboard, location, biometry, sensors,
file downloads, QR, permissions, contact/prepared-message sharing, story
presentation, vertical dismissal controls and storage. Story/swipe operations
require the corresponding LO host rollout; earlier ports omit them.
The current decoder does not advertise invoices. Actual
availability still depends on the running LO client, device and permission.

## Native host requirement

`createAdapter` uses only `LO.MiniAppNative`. Native snapshots and events are
authoritative; an absent native host is unsupported. There is no WebApp fallback.

Launch assertions stay opaque and untrusted. Send their exact bytes to your
backend for verification. The adapter does not authenticate them.

## Launch identity and missing bot

`adapter.launchUnsafe()` (also `client.launchUnsafe()`) parses display-only launch
data; IDs stay strings and avatar URLs are restricted to HTTPS subdomains of
`lo.ink`. Verify `adapter.launchData` on your server before trusting it. Native
`NO_BOT` errors become `NoBot` from miniapp-sdk. Older host `false` stays false
and cannot distinguish a missing link from denial. Host rollout is separate from
this adapter release; no host version is claimed until its release is verified.

`themeChanged`, `viewportChanged`, inset and fullscreen events update `snapshot()` before listeners run. Older ports return their launch snapshot, so subscribed event fields take precedence for those hosts. The optional LO native transport flag `liveSnapshot: true` declares that the host maintains its snapshot before event delivery, including when no listeners are registered. On those hosts the validated current port snapshot is authoritative, including after an unsubscribe gap. Invalid event payloads cannot erase validated insets.

Native LO requests have a 60-second transport/host deadline. The effective deadline is the shorter of the caller's `timeoutMs` and 60 seconds. A longer SDK default (such as the shared `shareMessage` helper's five minutes) does not extend the LO host deadline. Timeout sends a best-effort cancellation and releases listeners; it cannot undo a native action that has already completed.

Hosts that suspend UI operations while the Mini App is hidden report `ABORTED` for interrupted UI requests and `NOT_AVAILABLE` for new UI requests. The adapter maps these to the existing SDK codes `aborted` and `failed`, respectively; they are valid host failures, not malformed responses. Older host error codes remain supported.
