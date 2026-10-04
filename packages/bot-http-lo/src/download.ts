import {
  BotError,
  BotApiError,
  Unavailable,
  validateFilePath,
  type BotOperations,
} from "@lo-ink/bot-sdk";

/** Authenticate to the file route; never follow redirects carrying the bot token. */
export async function downloadFileStream(
  baseUrl: string,
  token: string,
  fetcher: typeof fetch,
  input: BotOperations["downloadFile"]["input"],
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  if (input.signal !== undefined) {
    if (!(input.signal instanceof AbortSignal))
      throw new BotError("invalid-input", "Expected a download AbortSignal.");
    signal = AbortSignal.any([signal, input.signal]);
  }
  validateFilePath(input.path);
  const max = input.maxBytes ?? 50 * 1024 * 1024;
  if (!Number.isSafeInteger(max) || max < 1 || max > 50 * 1024 * 1024)
    throw new BotError("invalid-input", "Invalid download size limit.");
  if (signal.aborted) throw new BotError("aborted", "Request aborted.");
  let response: Response;
  try {
    response = await fetcher(
      `${baseUrl}file/bot${token}/${input.path
        .split("/")
        .map((part) => encodeURIComponent(decodeURIComponent(part)))
        .join("/")}`,
      { signal, redirect: "manual" },
    );
  } catch {
    throw signal.aborted
      ? new BotError("aborted", "Request aborted.")
      : new Unavailable("LO file download could not be started.");
  }
  const length = response.headers.get("content-length");
  if (
    !response.ok ||
    !response.body ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > max))
  ) {
    await response.body?.cancel().catch(() => {});
    if (response.status >= 500)
      throw new Unavailable(
        "LO file download is unavailable.",
        response.status,
      );
    throw new BotApiError(
      response.ok
        ? "invalid-response"
        : response.status === 403
          ? "forbidden"
          : response.status === 404
            ? "not-found"
            : "transport",
      "LO file download was refused.",
      response.status,
    );
  }
  const reader = response.body.getReader();
  let size = 0,
    finished = false,
    released = false;
  let target: ReadableStreamDefaultController<Uint8Array>;
  const abort = () => {
    if (finished) return;
    finished = true;
    target.error(new BotError("aborted", "Download aborted."));
    void reader
      .cancel()
      .catch(() => {})
      .then(release);
  };
  const release = () => {
    if (!released) {
      released = true;
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      target = controller;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          finished = true;
          release();
          controller.close();
          return;
        }
        size += value.byteLength;
        if (size > max) {
          await reader.cancel().catch(() => {});
          throw new BotError(
            "invalid-response",
            "LO file exceeds the download size limit.",
          );
        }
        controller.enqueue(value);
      } catch (error) {
        if (finished) return;
        finished = true;
        await reader.cancel().catch(() => {});
        release();
        controller.error(
          error instanceof BotError
            ? error
            : new Unavailable("LO file download was interrupted."),
        );
      }
    },
    async cancel() {
      finished = true;
      try {
        await reader.cancel();
      } finally {
        release();
      }
    },
  });
}
