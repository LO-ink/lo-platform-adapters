import { wireReplyMarkup } from "./keyboard.js";
import {
  BOT_MEDIA_LIMITS,
  BotError,
  validateInputFile,
  type BotOperations,
  type InputFile,
} from "@lo-ink/bot-sdk";

/** Buffer streams within the platform cap before fetch; never send a partial oversized upload. */
export async function fileBlob(
  input: InputFile,
  kind: "photo" | "document" | "voice" | "video" | "audio",
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
        throw new BotError(
          "invalid-input",
          "File exceeds the LO upload limit.",
        );
      }
      chunks.push(new Uint8Array(value).buffer);
    }
    return new Blob(chunks, { type });
  } catch (error) {
    // Stop the producer on malformed chunks and read errors, without replacing
    // the validation error or waiting on a potentially broken cancellation.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
export async function mediaRequest(
  operation:
    | "sendPhoto"
    | "sendDocument"
    | "sendVoice"
    | "sendVideo"
    | "sendAudio",
  input: BotOperations[
    | "sendPhoto"
    | "sendDocument"
    | "sendVoice"
    | "sendVideo"
    | "sendAudio"]["input"],
  signal: AbortSignal,
): Promise<Record<string, unknown> | FormData> {
  const kind = (
    {
      sendPhoto: "photo",
      sendDocument: "document",
      sendVoice: "voice",
      sendVideo: "video",
      sendAudio: "audio",
    } as const
  )[operation];
  const value = input as {
    conversationId: string;
    caption?: string;
    replyMarkup?: unknown;
    duration?: number;
    width?: number;
    height?: number;
    thumbnail?: InputFile;
    supportsStreaming?: boolean;
  } & Record<typeof kind, InputFile>;
  const file = value[kind];
  validateInputFile(file, kind);
  const fields: Record<string, unknown> = {
    chat_id: value.conversationId,
    ...(value.caption !== undefined ? { caption: value.caption } : {}),
    ...(value.replyMarkup !== undefined
      ? { reply_markup: wireReplyMarkup(value.replyMarkup) }
      : {}),
  };
  if ("fileId" in file && file.fileId !== undefined)
    return {
      ...fields,
      [kind]: file.fileId,
      ...(value.supportsStreaming !== undefined
        ? { supports_streaming: value.supportsStreaming }
        : {}),
    };
  const upload = file as Exclude<InputFile, { fileId: string }>;
  const blob = await fileBlob(upload, kind, signal);
  if (operation === "sendVideo") {
    for (const key of ["duration", "width", "height"] as const)
      if (value[key] !== undefined) fields[key] = value[key];
    if (value.supportsStreaming !== undefined)
      fields.supports_streaming = value.supportsStreaming;
  }
  const form = new FormData();
  for (const [key, val] of Object.entries(fields))
    form.append(key, typeof val === "string" ? val : JSON.stringify(val));
  form.append(kind, blob, upload.name);
  if (value.thumbnail !== undefined) {
    const thumb = value.thumbnail as Exclude<InputFile, { fileId: string }>;
    form.append(
      "thumbnail",
      await fileBlob(thumb, "photo", signal),
      thumb.name,
    );
  }
  return form;
}

export async function albumRequest(
  input: BotOperations["sendMediaGroup"]["input"],
  signal: AbortSignal,
): Promise<Record<string, unknown> | FormData> {
  const uploads: Array<{ name: string; blob: Blob; filename: string }> = [];
  const media = [];
  for (let i = 0; i < input.media.length; i++) {
    const item = input.media[i]!,
      file = item.media;
    let reference: string;
    if ("fileId" in file && file.fileId !== undefined) reference = file.fileId;
    else {
      const upload = file as Exclude<InputFile, { fileId: string }>;
      const name = "media_" + i;
      reference = "attach://" + name;
      uploads.push({
        name,
        blob: await fileBlob(upload, item.type, signal),
        filename: upload.name,
      });
    }
    media.push({
      type: item.type,
      media: reference,
      ...(item.caption !== undefined ? { caption: item.caption } : {}),
    });
  }
  if (!uploads.length) return { chat_id: input.conversationId, media };
  const form = new FormData();
  form.append("chat_id", input.conversationId);
  form.append("media", JSON.stringify(media));
  for (const upload of uploads)
    form.append(upload.name, upload.blob, upload.filename);
  return form;
}
