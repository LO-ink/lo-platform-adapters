import {
  BOT_MEDIA_LIMITS,
  BotError,
  validateInputFile,
  type BotOperations,
  type InputFile,
} from "@lo-ink/bot-sdk";

/** Buffer streams within the platform cap before fetch; never send a partial oversized upload. */
async function fileBlob(
  input: InputFile,
  kind: "photo" | "document" | "voice",
  signal: AbortSignal,
): Promise<Blob> {
  validateInputFile(input, kind);
  if ("fileId" in input && input.fileId !== undefined)
    throw new BotError("invalid-input", "Expected upload data.");
  const { data, mime, name } = input as Exclude<InputFile, { fileId: string }>;
  if (signal.aborted) throw new BotError("aborted", "Request aborted.");
  const type =
    (mime ?? (data instanceof Blob ? data.type : "")) ||
    (kind === "voice"
      ? /\.aac$/i.test(name)
        ? "audio/aac"
        : "audio/mp4"
      : "application/octet-stream");
  if (data instanceof Blob) return new Blob([data], { type });
  if (data instanceof Uint8Array)
    return new Blob([new Uint8Array(data)], { type });
  const reader = data.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new BotError("aborted", "Request aborted.");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new BotError("aborted", "Request aborted.");
      if (done) break;
      if (!(value instanceof Uint8Array))
        throw new BotError("invalid-input", "Expected byte stream chunks.");
      size += value.byteLength;
      if (size > BOT_MEDIA_LIMITS[`${kind}Bytes`]) {
        void reader.cancel().catch(() => {});
        throw new BotError(
          "invalid-input",
          "File exceeds the LO upload limit.",
        );
      }
      chunks.push(new Uint8Array(value).buffer);
    }
    return new Blob(chunks, { type });
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
export async function mediaRequest(
  operation: "sendPhoto" | "sendDocument" | "sendVoice",
  input: BotOperations["sendPhoto" | "sendDocument" | "sendVoice"]["input"],
  signal: AbortSignal,
): Promise<Record<string, unknown> | FormData> {
  const kind =
    operation === "sendPhoto"
      ? "photo"
      : operation === "sendDocument"
        ? "document"
        : "voice";
  const value = input as {
    conversationId: string;
    caption?: string;
    replyMarkup?: unknown;
  } & Record<typeof kind, InputFile>;
  const file = value[kind];
  validateInputFile(file, kind);
  const fields: Record<string, unknown> = {
    chat_id: value.conversationId,
    ...(value.caption !== undefined ? { caption: value.caption } : {}),
    ...(value.replyMarkup !== undefined
      ? { reply_markup: value.replyMarkup }
      : {}),
  };
  if ("fileId" in file && file.fileId !== undefined)
    return { ...fields, [kind]: file.fileId };
  const upload = file as Exclude<InputFile, { fileId: string }>;
  const blob = await fileBlob(upload, kind, signal);
  const form = new FormData();
  for (const [key, val] of Object.entries(fields))
    form.append(key, typeof val === "string" ? val : JSON.stringify(val));
  form.append(kind, blob, upload.name);
  return form;
}
