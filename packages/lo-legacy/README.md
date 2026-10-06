# `@lo-ink/adapter-lo-legacy`

Opt-in integration for applications that still need the older `LO.WebApp`
surface. New native applications use `createLoClient` from `@lo-ink/miniapp-sdk`.

```ts
import { createAdapter } from "@lo-ink/adapter-lo-legacy";
import { createMiniAppClient } from "@lo-ink/miniapp-sdk";

const adapter = createAdapter();
const client = adapter ? createMiniAppClient(adapter) : null;
```

This adapter selects only LO.WebApp. It never discovers or composes a native
port. Select createLoClient from @lo-ink/miniapp-sdk explicitly for native operations. Capabilities,
events and snapshots always belong to the selected transport.

The adapter keeps the `lo-legacy-webapp` identity. Your backend must
verify LO launch data for that identity; it must not select another provider's
signature algorithm from the compatibility API name. Launch data is never
modified by this package.

Remove this dependency only after the released LO host covers the application's
required operations and runtime acceptance passes. Installing the package does
not change or inject any browser global.
