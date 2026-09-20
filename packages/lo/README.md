# `@lo-ink/adapter-lo`

Adapter for the canonical LO Mini App native port with a compatibility fallback for clients that still expose `LO.WebApp`. Discovery is synchronous and performs no script loading or authentication.

```ts
import { createAdapter } from "@lo-ink/adapter-lo";

const adapter = createAdapter();
```

When `LO.MiniAppNative` is valid, the adapter uses its versioned JSON transport for the operations, capabilities and events explicitly advertised by the host. Matching-session legacy coverage is composed only outside that native set. A failed native request is never retried through the legacy object. A current complete native port advertises canonical snapshot and event authority. Older six-operation ports do not; their appearance snapshot and events continue to come from the matching-session legacy object.

The canonical transport covers every capability shipped by LO: app chrome and appearance, fullscreen, keyboard and orientation, haptics and popups, links and inline queries, clipboard, location, biometry, sensors, downloads, QR scanning, permissions and contact/prepared-message sharing, plus cloud, device and secure storage. Invoice and story-sharing operations are intentionally absent until their native hosts ship. Older hosts may expose missing operations through a matching-session legacy object. The launch payload stays opaque; send it unchanged to an application backend for verification.
