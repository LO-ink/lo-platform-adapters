import {
  bindAppearance,
  createMiniAppClient,
  requestWriteAccess,
} from "@lo-ink/miniapp-sdk";
import { createAdapter as createLoAdapter } from "@lo-ink/adapter-lo";
import { createAdapter as createLegacyLoAdapter } from "@lo-ink/adapter-lo-legacy";
import { loadAdapter as loadTelegramAdapter } from "@lo-ink/adapter-telegram";

// Set data-miniapp-host on the entry document to an explicitly deployed host.
// Host selection is configuration, never identity verification.
async function selectAdapter(host: string | undefined) {
  switch (host) {
    case "lo-native":
      return createLoAdapter();
    case "lo-legacy":
      return createLegacyLoAdapter();
    case "telegram":
      return loadTelegramAdapter();
    default:
      throw new Error(
        "Configure data-miniapp-host: lo-native, lo-legacy or telegram",
      );
  }
}
const adapter = await selectAdapter(
  document.documentElement.dataset.miniappHost,
);
if (!adapter) throw new Error("Open this Mini App inside a supported host");

const client = createMiniAppClient(adapter);
const media = matchMedia("(prefers-color-scheme: dark)");
const stopAppearance = bindAppearance(client, {
  root: document.documentElement,
  prefersDark: () => media.matches,
  background: (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name),
  onPreferenceChange: (listener) => {
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  },
});

if (client.supports("ready")) await client.call("ready", undefined);
if (client.supports("expand")) await client.call("expand", undefined);

document
  .querySelector("#request-messages")
  ?.addEventListener("click", async () => {
    const allowed = await requestWriteAccess(client);
    document.documentElement.dataset.writeAccess = allowed
      ? "allowed"
      : "denied";
  });

addEventListener(
  "pagehide",
  () => {
    stopAppearance();
    client.dispose();
  },
  { once: true },
);
