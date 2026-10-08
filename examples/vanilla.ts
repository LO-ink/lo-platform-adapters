import { createLoClient } from "@lo-ink/miniapp-sdk";
import { startExample } from "./lifecycle.js";

await startExample(() => {
  const client = createLoClient();
  if (!client) throw new Error("Open this Mini App inside LO");
  return client;
});
