import {
  createMiniAppClient,
  createNativeAdapter as createLoAdapter,
} from "@lo-ink/miniapp-sdk";
import { loadAdapter as loadTelegramAdapter } from "@lo-ink/adapter-telegram";
import { startExample } from "./lifecycle.js";

// Set data-miniapp-host on the entry document to an explicitly deployed host.
// Host selection is configuration, never identity verification.
async function selectAdapter(host: string | undefined) {
  switch (host) {
    case "lo-native":
      return createLoAdapter();
    case "telegram":
      return loadTelegramAdapter();
    default:
      throw new Error("Configure data-miniapp-host: lo-native or telegram");
  }
}
await startExample(async () => {
  const adapter = await selectAdapter(
    document.documentElement.dataset.miniappHost,
  );
  if (!adapter) throw new Error("Open this Mini App inside a supported host");
  return createMiniAppClient(adapter);
});
