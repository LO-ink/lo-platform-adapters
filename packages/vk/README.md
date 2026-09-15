# `@lo/adapter-vk`

VK Mini Apps host adapter for `@lo/miniapp-sdk`, built on the official `@vkontakte/vk-bridge` package.

```ts
import bridge from "@vkontakte/vk-bridge";
import { createAdapter } from "@lo/adapter-vk";
import { createMiniAppClient } from "@lo/miniapp-sdk";

const adapter = await createAdapter({
  bridge,
  launchData: window.location.search,
  timeoutMs: 5_000,
});
const miniApp = createMiniAppClient(adapter);

await miniApp.call("ready", undefined);
miniApp.on("themeChanged", ({ colorScheme }) => {
  document.documentElement.dataset.theme = colorScheme ?? "light";
});
```

`createAdapter` sends `VKWebAppInit` and `VKWebAppGetConfig` before it resolves. Initialization is bounded by one shared timeout and an optional abort signal. `launchData` is retained exactly as supplied; this browser adapter does not parse or authenticate it.

`detectAdapter` first checks `bridge.isEmbedded()` and returns `null` outside a VK host. Both factories accept an injected bridge for explicit ownership and testing; importing this package does not add a script tag or load a remote bridge.

The adapter advertises only the complete `ready` capability. It normalizes the official config, inset, view-hide, and view-restore events into `themeChanged`, `viewportChanged`, `safeAreaChanged`, `deactivated`, and `activated`. VK Bridge 3.0.2 does not expose a general external-link request, so `openLink` is unsupported. Cloud storage is also unsupported because the LO capability includes remove operations that VK storage does not provide.
