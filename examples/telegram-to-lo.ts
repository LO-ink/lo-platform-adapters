import {
  installTelegramCompatibility,
  type Failure,
} from "@lo-ink/adapter-telegram-to-lo";

/** Use a canonical-only host, before loading the audited foreign API entrypoint. */
export async function startExistingApplication(
  loadApplication: () => Promise<unknown>,
  onError: (failure: Failure) => void,
  signal?: AbortSignal,
) {
  const lease = installTelegramCompatibility({ onError, signal });
  if (!lease) throw new Error("Canonical LO host is unavailable");
  try {
    await loadApplication();
  } catch (error) {
    await lease.dispose();
    throw error;
  }
  return () => lease.dispose();
}
