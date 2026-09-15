# `@lo/adapter-lo`

Transitional adapter for LO clients that expose the legacy `LO.WebApp` compatibility object. It requires a nonempty launch payload and trusts only the host's explicit capability list. This is Telegram-compatible behavior hosted by LO; it is not the future native LO bridge.

```ts
import { createAdapter } from "@lo/adapter-lo";

const adapter = createAdapter();
```
