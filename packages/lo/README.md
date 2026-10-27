# `@lo-ink/adapter-lo`

Compatibility exports for the native `@lo-ink/miniapp-sdk` transport, supporting
SDK `^0.22.2 || ^0.23.0 || ^0.27.0`. New LO applications use the SDK directly:

```ts
import { createLoClient } from "@lo-ink/miniapp-sdk";
const client = createLoClient();
if (!client) throw new Error("A supported LO host is required");
```

Existing `createAdapter`, `detectAdapter` and `createNativeAdapter` imports are SDK
aliases; native types remain exported. This package has no separate decoder or
request state. See the [Mini App SDK](https://github.com/LO-ink/lo-miniapp-sdk#readme)
for operations, snapshots, lifecycle and appearance bindings.

Discovery uses only `LO.MiniAppNative` and returns `null` for an absent or invalid
port. Capabilities intersect SDK operations with advertised host features; unknown
features are ignored. Package versions do not prove support on an installed LO
client. Story/swipe controls require the corresponding host rollout, and invoices
are not advertised. Native failures never trigger a WebApp fallback.

Launch data is untrusted. Verify its exact bytes on your backend before trusting
identity or permissions. `launchUnsafe()` is display-only. A native `NO_BOT` maps
to the SDK's `NoBot`; older hosts may return only `false`.

With `liveSnapshot: true`, the host updates its snapshot before dispatching
an event; the validated current snapshot remains authoritative after a gap in
subscriptions. Older ports retain a launch snapshot, so received event values
take precedence there.

Native requests have a maximum 60-second deadline; a shorter caller timeout takes
precedence. Cancellation cannot undo a completed native action. Hidden-host UI
interruptions (`ABORTED`) map to `aborted`, and unavailable operations
(`NOT_AVAILABLE`) map to `failed`.
