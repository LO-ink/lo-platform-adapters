# `@lo-ink/adapter-lo`

Native LO integration for `@lo-ink/miniapp-sdk`. Version 0.22 discovers only
`LO.MiniAppNative` and speaks the LO-owned, versioned JSON protocol. There is no
compatibility dependency, script loading or automatic fallback.

```ts
import { createMiniAppClient } from "@lo-ink/miniapp-sdk";
import { createAdapter } from "@lo-ink/adapter-lo";

const adapter = createAdapter();
if (!adapter) throw new Error("A supported LO host is required");
const client = createMiniAppClient(adapter);
```

Discovery returns `null` for an absent or invalid port. Capabilities are the
intersection of operations implemented by this package and the features
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

## Migration from 0.21

This is a breaking adapter release: `createAdapter` no longer composes or reads
`LO.WebApp`. Native snapshots and events are authoritative. If your released
host still needs the older surface, keep 0.21 pinned or explicitly use
[`@lo-ink/adapter-lo-legacy`](https://github.com/LO-ink/lo-platform-adapters/tree/main/packages/lo-legacy). Do not upgrade an existing
application until its required native capabilities and events are available.

Launch assertions stay opaque and untrusted. Send their exact bytes to your
backend for verification. The adapter does not authenticate them.
