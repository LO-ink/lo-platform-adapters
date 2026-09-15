import {
  bindAppearance,
  createMiniAppClient,
  requestWriteAccess,
} from "@lo-ink/miniapp-sdk";
import { createAdapter as createLoAdapter } from "@lo-ink/adapter-lo";
import { loadAdapter as loadTelegramAdapter } from "@lo-ink/adapter-telegram";

const adapter = createLoAdapter() ?? (await loadTelegramAdapter());
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
