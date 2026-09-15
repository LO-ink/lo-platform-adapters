# `@lo/adapter-lo`

Adapter for the canonical LO Mini App native port with a compatibility fallback for clients that still expose `LO.WebApp`. Discovery is synchronous and performs no script loading or authentication.

```ts
import { createAdapter } from "@lo/adapter-lo";

const adapter = createAdapter();
```

When `LO.MiniAppNative` is valid, the adapter uses its versioned JSON transport for the operations and capabilities explicitly advertised by the host. Matching-session legacy coverage is composed only for operations outside that native set. A failed native request is never retried through the legacy object. Canonical lifecycle events come from the native port; legacy appearance events and snapshots remain live during the transition.

The initial canonical slice includes `ready`, `expand`, closing confirmation, links, `sendData`, and write-access requests, plus activated/deactivated events. Other operations remain available only when a matching legacy object advertises them. The launch payload stays opaque; send it unchanged to an application backend for verification.
