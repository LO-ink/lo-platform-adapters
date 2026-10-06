import { interactionUpdate } from "./interactions.js";
import { wireReplyMarkup, wireMenuButton } from "./keyboard.js";
import { mediaRequest, albumRequest } from "./media.js";
import { downloadFileStream } from "./download.js";
import {
  BotApiError as HttpBotError,
  RateLimited,
  NotAllowed,
  BadRequest,
  Unavailable,
  validateReplyMarkup,
  validateMenuButton,
  validateCaption,
  validateVideo,
  validateAlbum,
  type BotFile,
  type BotFailureDetails,
  type BotFailureReason,
  type BotCommand,
  type BotErrorCode,
  type BotIdentity,
  type BotOperations,
  type BotTransport,
  type SecretaryOperations,
  type SecretaryTransport,
  type BotUpdate,
  type Message,
} from "@lo-ink/bot-sdk";

import { parseLosslessJson } from "./lossless-json.js";

import {
  decodeSecretaryUpdate,
  normalizeSecretaryResult,
  wireSecretaryRequest,
} from "./secretary.js";

const defaultBaseUrl = "https://api.lo.ink";
const maxResponseBytes = 2 << 20;
const integerPattern = /^-?(?:0|[1-9][0-9]*)$/;
const tokenPattern = /^[1-9][0-9]*:[A-Za-z0-9_-]+$/;
const commandPattern = /^[a-z0-9_]{1,32}$/;
const chatTypes = new Set(["private", "group", "supergroup", "channel"]);

export interface LoHttpBotTransportOptions {
  /** Secret bot credential. Keep this transport on the application server. */
  token: string;
  /** Bot API origin or path prefix. Defaults to https://api.lo.ink. */
  baseUrl?: string;
  /** Allows HTTP only for localhost, 127.0.0.1, or ::1. Intended for tests. */
  allowInsecureLoopback?: boolean;
  /** Optional fetch-compatible implementation. Native global fetch is the default. */
  fetch?: typeof globalThis.fetch;
}

export { HttpBotError };

function configurationError(message: string): HttpBotError {
  return new HttpBotError("invalid-input", message);
}

function normalizeBaseUrl(
  value: string,
  allowInsecureLoopback: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError("baseUrl must be an absolute URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw configurationError(
      "baseUrl must not contain credentials, a query, or a fragment.",
    );
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  const secure = url.protocol === "https:";
  const allowedLocalHttp =
    url.protocol === "http:" && loopback && allowInsecureLoopback;
  if (!secure && !allowedLocalHttp) {
    throw configurationError(
      "baseUrl must use HTTPS; loopback HTTP requires explicit opt-in.",
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.href;
}

function parseJson(text: string): unknown {
  try {
    return parseLosslessJson(text);
  } catch {
    throw new HttpBotError(
      "invalid-response",
      "LO Bot API returned malformed JSON.",
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function identifier(value: unknown, positive = false): string | null {
  let result: string;
  if (typeof value === "string" && integerPattern.test(value)) {
    result = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    result = String(value);
  } else {
    return null;
  }
  if (
    result === "0" ||
    result === "-0" ||
    (positive && result.startsWith("-"))
  ) {
    return null;
  }
  return result;
}

function invalidResult(): HttpBotError {
  return new HttpBotError(
    "invalid-response",
    "LO Bot API returned an invalid result.",
  );
}

function botIdentity(value: unknown): BotIdentity {
  const object = record(value);
  const id = identifier(object?.id, true);
  if (
    !object ||
    !id ||
    object.is_bot !== true ||
    typeof object.first_name !== "string" ||
    !object.first_name ||
    typeof object.can_join_groups !== "boolean" ||
    typeof object.can_read_all_group_messages !== "boolean" ||
    typeof object.supports_inline_queries !== "boolean"
  ) {
    throw invalidResult();
  }
  if (object.username !== undefined && typeof object.username !== "string") {
    throw invalidResult();
  }
  if (
    object.capabilities !== undefined &&
    (!record(object.capabilities) ||
      !Object.values(record(object.capabilities) ?? {}).every(
        (value) => typeof value === "boolean",
      ))
  )
    throw invalidResult();
  return {
    id,
    name: object.first_name,
    canJoinGroups: object.can_join_groups,
    canReadAllGroupMessages: object.can_read_all_group_messages,
    supportsInlineQueries: object.supports_inline_queries,
    ...(record(object.capabilities)
      ? {
          capabilities: Object.fromEntries(
            Object.entries({
              video_uploads: "videoUploads",
              audio_uploads: "audioUploads",
              single_attach: "singleAttach",
              media_groups: "mediaGroups",
              chat_actions: "chatActions",
            })
              .filter(
                ([key]) =>
                  typeof (object.capabilities as Record<string, unknown>)[
                    key
                  ] === "boolean",
              )
              .map(([key, name]) => [
                name,
                (object.capabilities as Record<string, unknown>)[key],
              ]),
          ),
        }
      : {}),
    ...(object.username ? { handle: object.username } : {}),
  };
}

function message(
  value: unknown,
  expectedConversationId?: string,
  requireText = false,
): Message {
  const object = record(value);
  const chat = record(object?.chat);
  const id = identifier(object?.message_id, true);
  const conversationId = identifier(chat?.id);
  if (
    !object ||
    !chat ||
    !id ||
    !conversationId ||
    typeof object.date !== "number" ||
    !Number.isSafeInteger(object.date) ||
    object.date < 0 ||
    typeof chat.type !== "string" ||
    !chatTypes.has(chat.type) ||
    (expectedConversationId !== undefined &&
      conversationId !== expectedConversationId) ||
    (requireText && typeof object.text !== "string") ||
    (!requireText &&
      object.text !== undefined &&
      typeof object.text !== "string")
  ) {
    throw invalidResult();
  }
  return {
    id,
    conversationId,
    ...(typeof object.text === "string" ? { text: object.text } : {}),
  };
}

function commands(value: unknown): readonly BotCommand[] {
  if (!Array.isArray(value)) throw invalidResult();
  return value.map((item) => {
    const object = record(item);
    if (
      !object ||
      typeof object.command !== "string" ||
      !commandPattern.test(object.command) ||
      typeof object.description !== "string" ||
      !object.description.trim()
    ) {
      throw invalidResult();
    }
    return { name: object.command, description: object.description };
  });
}

function incomingMessage(raw: unknown): Message {
  const result = message(raw),
    object = record(raw)!;
  if (object.caption !== undefined && typeof object.caption !== "string")
    throw invalidResult();
  let attachment: Record<string, unknown> | null = null,
    mediaType: Message["mediaType"];
  for (const kind of [
    "photo",
    "document",
    "voice",
    "video",
    "audio",
  ] as const) {
    if (!Object.hasOwn(object, kind)) continue;
    if (mediaType !== undefined) throw invalidResult();
    mediaType = kind;
    const raw = object[kind];
    attachment = record(
      kind === "photo" ? (Array.isArray(raw) ? raw.at(-1) : undefined) : raw,
    );
    if (
      !attachment ||
      typeof attachment.file_id !== "string" ||
      !attachment.file_id
    )
      throw invalidResult();
  }
  return {
    ...result,
    ...(typeof object.caption === "string" ? { caption: object.caption } : {}),
    ...(attachment ? { fileId: attachment.file_id as string, mediaType } : {}),
  };
}

function updates(value: unknown): readonly BotUpdate[] {
  if (!Array.isArray(value)) throw invalidResult();
  return value.map(decodeLoBotUpdate);
}

/** Normalize a verified webhook or poll update. Never authenticates the sender. */
export function decodeLoBotUpdate(value: unknown): BotUpdate {
  const object = record(value);
  const id = identifier(object?.update_id, true);
  if (!object || !id) throw invalidResult();
  const delegated = decodeSecretaryUpdate(object, id);
  if (delegated) return delegated;
  const interaction = interactionUpdate(
    object,
    id,
    identifier,
    incomingMessage,
  );
  if (interaction) return interaction;
  if (Object.hasOwn(object, "message"))
    return { id, kind: "message", message: incomingMessage(object.message) };
  return { id, kind: "unhandled" };
}

/** Parse the bounded, authenticated webhook body without losing 64-bit IDs. */
export function parseLoBotWebhookUpdate(body: string): BotUpdate {
  if (
    typeof body !== "string" ||
    new TextEncoder().encode(body).length > maxResponseBytes
  )
    throw invalidResult();
  return decodeLoBotUpdate(parseJson(body));
}

function wireRequest<K extends keyof BotOperations>(
  operation: K,
  input: BotOperations[K]["input"],
): { method: string; body: Record<string, unknown> } {
  switch (operation) {
    case "getIdentity":
      return { method: "getMe", body: {} };
    case "answerCallback": {
      const answer = input as BotOperations["answerCallback"]["input"];
      return {
        method: "answerCallbackQuery",
        body: {
          callback_query_id: answer.callbackId,
          ...(answer.text !== undefined ? { text: answer.text } : {}),
          ...(answer.showAlert !== undefined
            ? { show_alert: answer.showAlert }
            : {}),
        },
      };
    }
    case "getFile":
      return {
        method: "getFile",
        body: { file_id: (input as BotOperations["getFile"]["input"]).fileId },
      };
    case "sendMessage": {
      const value = input as BotOperations["sendMessage"]["input"];
      return {
        method: "sendMessage",
        body: {
          chat_id: value.conversationId,
          text: value.text,
          ...(value.replyMarkup !== undefined
            ? { reply_markup: wireReplyMarkup(value.replyMarkup) }
            : {}),
        },
      };
    }
    case "editMessage": {
      const value = input as BotOperations["editMessage"]["input"];
      return {
        method: "editMessageText",
        body: {
          chat_id: value.conversationId,
          message_id: value.messageId,
          text: value.text,
          ...(value.replyMarkup !== undefined
            ? { reply_markup: wireReplyMarkup(value.replyMarkup) }
            : {}),
        },
      };
    }
    case "setChatMenuButton": {
      const value = input as BotOperations["setChatMenuButton"]["input"];
      validateMenuButton(value.menuButton);
      return {
        method: "setChatMenuButton",
        body: {
          ...(value.conversationId !== undefined
            ? { chat_id: value.conversationId }
            : {}),
          menu_button: wireMenuButton(value.menuButton),
        },
      };
    }
    case "deleteMessage": {
      const value = input as BotOperations["deleteMessage"]["input"];
      return {
        method: "deleteMessage",
        body: {
          chat_id: value.conversationId,
          message_id: value.messageId,
        },
      };
    }
    case "getCommands":
      return { method: "getMyCommands", body: {} };
    case "setCommands": {
      const value = input as BotOperations["setCommands"]["input"];
      return {
        method: "setMyCommands",
        body: {
          commands: value.commands.map((command) => ({
            command: command.name,
            description: command.description,
          })),
        },
      };
    }
    case "getUpdates": {
      const value = input as BotOperations["getUpdates"]["input"];
      return {
        method: "getUpdates",
        body: {
          ...(value.offset !== undefined ? { offset: value.offset } : {}),
          ...(value.limit !== undefined ? { limit: value.limit } : {}),
          ...(value.waitSeconds !== undefined
            ? { timeout: value.waitSeconds }
            : {}),
        },
      };
    }
    default:
      throw configurationError("Unsupported bot operation.");
  }
}

function canonicalCode(platformCode: number): BotErrorCode {
  switch (platformCode) {
    case 400:
      return "invalid-input";
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return "not-found";
    case 409:
      return "conflict";
    case 429:
      return "rate-limited";
    case 501:
      return "unsupported";
    default:
      return platformCode >= 500 ? "unavailable" : "transport";
  }
}

function errorMessage(code: BotErrorCode): string {
  switch (code) {
    case "invalid-input":
      return "LO Bot API rejected the request.";
    case "unauthenticated":
      return "LO Bot API rejected the bot credential.";
    case "forbidden":
      return "LO Bot API denied the operation.";
    case "not-found":
      return "LO Bot API could not find the requested resource.";
    case "conflict":
      return "LO Bot API reported an operation conflict.";
    case "rate-limited":
      return "LO Bot API rate limit was reached.";
    case "unsupported":
      return "LO Bot API does not support the operation.";
    case "unavailable":
      return "LO Bot API is unavailable.";
    default:
      return "LO Bot API request failed.";
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function retryAfter(
  envelope: Record<string, unknown> | null,
  response: Response,
): number | undefined {
  const parameters = record(envelope?.parameters);
  const fromBody = positiveInteger(parameters?.retry_after);
  if (fromBody !== undefined) return fromBody;
  const header = response.headers.get("retry-after");
  if (!header || !/^[0-9]+$/.test(header)) return undefined;
  const parsed = Number(header);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function responseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxResponseBytes) {
      await reader.cancel();
      throw new HttpBotError(
        "invalid-response",
        "LO Bot API response exceeded the size limit.",
        response.status,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function normalizeResult<K extends keyof BotOperations>(
  operation: K,
  input: BotOperations[K]["input"],
  value: unknown,
): BotOperations[K]["output"] {
  let result:
    | BotIdentity
    | Message
    | boolean
    | readonly BotCommand[]
    | readonly BotUpdate[];
  if (operation === "getFile") {
    const file = record(value);
    if (
      !file ||
      typeof file.file_id !== "string" ||
      !file.file_id ||
      file.file_id !== (input as BotOperations["getFile"]["input"]).fileId ||
      typeof file.file_unique_id !== "string" ||
      !file.file_unique_id ||
      (file.file_path !== undefined && typeof file.file_path !== "string") ||
      (file.file_size !== undefined &&
        (typeof file.file_size !== "number" ||
          !Number.isSafeInteger(file.file_size) ||
          file.file_size < 0))
    )
      throw invalidResult();
    const normalized: BotFile = {
      fileId: file.file_id,
      uniqueId: file.file_unique_id,
      ...(typeof file.file_path === "string" ? { path: file.file_path } : {}),
      ...(typeof file.file_size === "number" ? { size: file.file_size } : {}),
    };
    return normalized as BotOperations[K]["output"];
  }
  if (operation === "sendMediaGroup") {
    const album = input as BotOperations["sendMediaGroup"]["input"];
    if (!Array.isArray(value) || value.length !== album.media.length)
      throw invalidResult();
    return value.map((item, index) =>
      normalizeResult(
        album.media[index]!.type === "photo" ? "sendPhoto" : "sendDocument",
        {
          conversationId: album.conversationId,
        } as BotOperations["sendPhoto"]["input"],
        item,
      ),
    ) as BotOperations[K]["output"];
  }
  switch (operation) {
    case "getIdentity":
      result = botIdentity(value);
      break;
    case "sendMessage":
      result = message(
        value,
        (input as BotOperations["sendMessage"]["input"]).conversationId,
        true,
      );
      break;
    case "editMessage":
      result = message(
        value,
        (input as BotOperations["editMessage"]["input"]).conversationId,
        true,
      );
      break;
    case "sendPhoto":
    case "sendDocument":
    case "sendVoice":
    case "sendVideo":
    case "sendAudio": {
      const normalized = message(
        value,
        (input as BotOperations["sendPhoto"]["input"]).conversationId,
      );
      const object = record(value)!;
      const media =
        operation === "sendPhoto"
          ? Array.isArray(object.photo)
            ? object.photo.at(-1)
            : null
          : object[
              (
                {
                  sendDocument: "document",
                  sendVoice: "voice",
                  sendVideo: "video",
                  sendAudio: "audio",
                } as const
              )[
                operation as
                  "sendDocument" | "sendVoice" | "sendVideo" | "sendAudio"
              ]
            ];
      const file = record(media);
      if (
        !file ||
        typeof file.file_id !== "string" ||
        !file.file_id ||
        (object.caption !== undefined && typeof object.caption !== "string")
      )
        throw invalidResult();
      result = {
        ...normalized,
        fileId: file.file_id,
        ...(typeof object.caption === "string"
          ? { caption: object.caption }
          : {}),
      };
      break;
    }
    case "setChatMenuButton":
    case "answerCallback":
    case "deleteMessage":
    case "setCommands":
      if (value !== true) throw invalidResult();
      result = true;
      break;
    case "getCommands":
      result = commands(value);
      break;
    case "getUpdates":
      result = updates(value);
      break;
    default:
      throw invalidResult();
  }
  return result as BotOperations[K]["output"];
}

/** Create the LO Bot API HTTP transport. No request is retried implicitly. */
export function createLoHttpBotTransport(
  options: LoHttpBotTransportOptions,
): BotTransport & SecretaryTransport {
  if (!options || typeof options !== "object") {
    throw configurationError("Transport options are required.");
  }
  if (typeof options.token !== "string" || !tokenPattern.test(options.token)) {
    throw configurationError("token is missing or malformed.");
  }
  const token = options.token;
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? defaultBaseUrl,
    options.allowInsecureLoopback === true,
  );
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw configurationError("A fetch implementation is required.");
  }

  function apiError(
    status: number,
    platformCode: number,
    retry?: number,
    description?: unknown,
    parameters?: unknown,
    safeToRetry = false,
  ): HttpBotError {
    const params = record(parameters);
    const reasons = [
      "unsupported_parameter",
      "upload_only",
      "feature_disabled",
      "method_not_implemented",
    ];
    const details: BotFailureDetails = {
      ...(typeof params?.parameter === "string" &&
      /^[a-z_]{1,64}$/.test(params.parameter)
        ? { parameter: params.parameter }
        : {}),
      ...(typeof params?.reason === "string" && reasons.includes(params.reason)
        ? { reason: params.reason as BotFailureReason }
        : {}),
      ...(safeToRetry ? { safeToRetry: true } : {}),
    };
    if (platformCode === 429)
      return new RateLimited(retry, status, platformCode, details);
    if (platformCode === 403) return new NotAllowed(status, platformCode);
    if (platformCode === 400) {
      const safeDescription =
        typeof description === "string"
          ? description
              .slice(0, 1024)
              .split(token)
              .join("[redacted]")
              .replace(/[1-9][0-9]*:[A-Za-z0-9_-]+/g, "[redacted]")
              .replace(/https?:\/\/[^\s]+/g, "[URL]")
          : undefined;
      return new BadRequest(safeDescription, status, platformCode, details);
    }
    const code = canonicalCode(platformCode);
    if (platformCode >= 500)
      return new Unavailable(
        errorMessage(code),
        status,
        platformCode,
        code === "unsupported" ? "unsupported" : "unavailable",
        platformCode === 501
          ? { ...details, reason: details.reason ?? "method_not_implemented" }
          : details,
      );
    return new HttpBotError(
      code,
      errorMessage(code),
      status,
      platformCode,
      retry,
    );
  }

  async function executeHttp(
    request: { method: string; body: Record<string, unknown> | FormData },
    requestOptions: { signal: AbortSignal },
  ): Promise<unknown> {
    if (requestOptions.signal.aborted) {
      throw new HttpBotError("aborted", "Request aborted.");
    }
    let response: Response;
    try {
      response = await fetchImplementation(
        `${baseUrl}bot${token}/${request.method}`,
        {
          method: "POST",
          ...(request.body instanceof FormData
            ? {}
            : { headers: { "content-type": "application/json" } }),
          body:
            request.body instanceof FormData
              ? request.body
              : JSON.stringify(request.body),
          redirect: "manual",
          signal: requestOptions.signal,
        },
      );
    } catch {
      if (requestOptions.signal.aborted) {
        throw new HttpBotError("aborted", "Request aborted.");
      }
      throw new Unavailable(
        "LO Bot API request failed before receiving a response.",
        undefined,
        undefined,
        "transport",
      );
    }

    if (response.status >= 300 && response.status < 400) {
      try {
        await response.body?.cancel();
      } catch {
        /* Preserve the sanitized redirect failure. */
      }
      throw new HttpBotError(
        "transport",
        "LO Bot API refused an HTTP redirect.",
        response.status,
        response.status,
      );
    }

    let text: string;
    try {
      text = await responseText(response);
    } catch (error) {
      if (error instanceof HttpBotError) throw error;
      if (requestOptions.signal.aborted) {
        throw new HttpBotError("aborted", "Request aborted.");
      }
      throw new Unavailable(
        "LO Bot API response could not be read.",
        response.status,
        undefined,
        "transport",
      );
    }

    let parsed: unknown;
    try {
      parsed = parseJson(text);
    } catch (error) {
      if (!response.ok) {
        throw apiError(
          response.status,
          response.status,
          retryAfter(null, response),
        );
      }
      if (error instanceof HttpBotError) {
        throw new HttpBotError(
          error.code,
          error.message,
          response.status,
          response.status,
        );
      }
      throw error;
    }
    const envelope = record(parsed);
    if (!envelope || typeof envelope.ok !== "boolean") {
      if (response.status >= 500)
        throw apiError(response.status, response.status);
      throw new HttpBotError(
        "invalid-response",
        "LO Bot API returned an invalid response envelope.",
        response.status,
      );
    }
    const platformCode =
      positiveInteger(envelope?.error_code) ?? response.status;
    if (!response.ok || envelope?.ok !== true) {
      if (platformCode < 400) {
        throw new HttpBotError(
          "invalid-response",
          "LO Bot API returned an invalid error envelope.",
          response.status,
        );
      }
      throw apiError(
        response.status,
        platformCode,
        retryAfter(envelope, response),
        envelope.description,
        envelope.parameters,
        response.status === 429 &&
          envelope.ok === false &&
          platformCode === 429,
      );
    }
    if (!Object.hasOwn(envelope, "result") || envelope.result === null) {
      throw new HttpBotError(
        "invalid-response",
        "LO Bot API response contained no result.",
        response.status,
      );
    }
    return envelope.result;
  }
  return {
    async execute<K extends keyof BotOperations>(
      operation: K,
      input: BotOperations[K]["input"],
      requestOptions: { signal: AbortSignal },
    ): Promise<BotOperations[K]["output"]> {
      let request: { method: string; body: Record<string, unknown> | FormData };
      if (operation === "downloadFile")
        return (await downloadFileStream(
          baseUrl,
          token,
          fetchImplementation,
          input as BotOperations["downloadFile"]["input"],
          requestOptions.signal,
        )) as BotOperations[K]["output"];
      if (operation === "sendMediaGroup") {
        const album = input as BotOperations["sendMediaGroup"]["input"];
        validateAlbum(album.media);
        request = {
          method: operation,
          body: await albumRequest(album, requestOptions.signal),
        };
      } else if (
        operation === "sendPhoto" ||
        operation === "sendDocument" ||
        operation === "sendVoice" ||
        operation === "sendVideo" ||
        operation === "sendAudio"
      ) {
        const media = input as BotOperations[
          | "sendPhoto"
          | "sendDocument"
          | "sendVoice"
          | "sendVideo"
          | "sendAudio"]["input"];
        validateReplyMarkup(media.replyMarkup, media.conversationId, true);
        if (operation === "sendVideo")
          validateVideo(input as BotOperations["sendVideo"]["input"]);
        if (
          operation === "sendAudio" &&
          !("fileId" in (input as BotOperations["sendAudio"]["input"]).audio)
        )
          throw configurationError("LO audio uploads are unavailable.");
        if (operation === "sendVoice" && Object.hasOwn(media, "caption"))
          throw configurationError(
            "LO voice messages do not support captions.",
          );
        validateCaption((media as { caption?: string }).caption);
        request = {
          method: operation,
          body: await mediaRequest(operation, media, requestOptions.signal),
        };
      } else {
        if (operation === "sendMessage" || operation === "editMessage") {
          const value = input as BotOperations["sendMessage"]["input"];
          validateReplyMarkup(
            value.replyMarkup,
            value.conversationId,
            operation === "editMessage",
          );
        }
        request = wireRequest(operation, input);
      }
      return normalizeResult(
        operation,
        input,
        await executeHttp(request, requestOptions),
      );
    },
    async executeSecretary<K extends keyof SecretaryOperations>(
      operation: K,
      input: SecretaryOperations[K]["input"],
      requestOptions: { signal: AbortSignal },
    ): Promise<SecretaryOperations[K]["output"]> {
      return normalizeSecretaryResult(
        operation,
        input,
        await executeHttp(
          wireSecretaryRequest(operation, input),
          requestOptions,
        ),
      );
    },
  };
}
