# `@lo-ink/adapter-lo-legacy`

Opt-in integration for applications that still need the older `LO.WebApp`
surface. New native applications use `@lo-ink/adapter-lo` directly.

```ts
import { createAdapter } from "@lo-ink/adapter-lo-legacy";
import { createMiniAppClient } from "@lo-ink/miniapp-sdk";

const adapter = createAdapter();
const client = adapter ? createMiniAppClient(adapter) : null;
```

This package preserves the 0.21 composition behavior: prefer native operations,
then use legacy capabilities only when both launch assertions match exactly.
Different sessions never compose. Native failures are never retried through the
legacy API. Older partial native ports use the matching legacy appearance;
complete native ports retain their own snapshot and event authority.

A legacy-only adapter keeps the `lo-legacy-webapp` identity. Your backend must
verify LO launch data for that identity; it must not select another provider's
signature algorithm from the compatibility API name. Launch data is never
modified by this package.

Remove this dependency only after the released LO host covers the application's
required operations and runtime acceptance passes. Installing the package does
not change or inject any browser global.
