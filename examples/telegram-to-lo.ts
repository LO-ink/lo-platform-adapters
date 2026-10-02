import { installTelegramCompatibility } from "@lo-ink/adapter-telegram-to-lo";

/** Run after the LO host is initialized and before the legacy entrypoint loads. */
export async function startExistingApplication(
  loadApplication: () => Promise<unknown>,
) {
  const lease = installTelegramCompatibility();
  if (!lease) throw new Error("LO compatibility host is unavailable");
  try {
    await loadApplication();
  } catch (error) {
    lease.dispose();
    throw error;
  }
  return () => lease.dispose();
}
