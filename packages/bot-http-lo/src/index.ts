import {
  BotError,
  type BotCommand,
  type BotErrorCode,
  type BotIdentity,
  type BotOperations,
  type BotTransport,
  type BotUpdate,
  type Message,
} from "@lo-ink/bot-sdk";

const defaultBaseUrl = "https://api.lo.ink";
const maxResponseBytes = 2 << 20;
const tokenPattern = /^[1-9][0-9]*:[A-Za-z0-9_-]+$/;
const integerPattern = /^-?(?:0|[1-9][0-9]*)$/;
const commandPattern = /^[a-z0-9_]{1,32}$/;
const chatTypes = new Set(["private", "group", "supergroup", "channel"]);

type JsonPrimitiveContext = { readonly source: string };
type LosslessJsonParse = (
  text: string,
  reviver: (
    this: unknown,
    key: string,
    value: unknown,
    context?: JsonPrimitiveContext,
  ) => unknown,
) => unknown;

const losslessJsonParse = JSON.parse as LosslessJsonParse;

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

/** A sanitized transport failure with HTTP and platform classification. */
export class HttpBotError extends BotError {
  constructor(
    code: BotErrorCode,
    message: string,
    readonly status?: number,
    readonly platformCode?: number,
    retryAfterSeconds?: number,
  ) {
    super(code, message, retryAfterSeconds);
    Object.defineProperty(this, "name", { value: "HttpBotError" });
  }
}

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
    return losslessJsonParse(text, (_key, value, context) => {
      if (
        typeof value === "number" &&
        Number.isInteger(value) &&
        !Number.isSafeInteger(value) &&
        context &&
        integerPattern.test(context.source)
      ) {
        return context.source;
      }
      return value;
    });
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
  return {
    id,
    name: object.first_name,
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

function updates(value: unknown): readonly BotUpdate[] {
  if (!Array.isArray(value)) throw invalidResult();
  return value.map((item) => {
    const object = record(item);
    const id = identifier(object?.update_id, true);
    if (!object || !id) throw invalidResult();
    if (Object.hasOwn(object, "message")) {
      return { id, kind: "message", message: message(object.message) };
    }
    return { id, kind: "unhandled" };
  });
}

function wireRequest<K extends keyof BotOperations>(
  operation: K,
  input: BotOperations[K]["input"],
): { method: string; body: Record<string, unknown> } {
  switch (operation) {
    case "getIdentity":
      return { method: "getMe", body: {} };
    case "sendMessage": {
      const value = input as BotOperations["sendMessage"]["input"];
      return {
        method: "sendMessage",
        body: { chat_id: value.conversationId, text: value.text },
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
): BotTransport {
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

  return {
    async execute<K extends keyof BotOperations>(
      operation: K,
      input: BotOperations[K]["input"],
      requestOptions: { signal: AbortSignal },
    ): Promise<BotOperations[K]["output"]> {
      if (requestOptions.signal.aborted) {
        throw new HttpBotError("aborted", "Request aborted.");
      }
      const request = wireRequest(operation, input);
      let response: Response;
      try {
        response = await fetchImplementation(
          `${baseUrl}bot${token}/${request.method}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request.body),
            redirect: "manual",
            signal: requestOptions.signal,
          },
        );
      } catch {
        if (requestOptions.signal.aborted) {
          throw new HttpBotError("aborted", "Request aborted.");
        }
        throw new HttpBotError(
          "transport",
          "LO Bot API request failed before receiving a response.",
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
        throw new HttpBotError(
          "transport",
          "LO Bot API response could not be read.",
          response.status,
        );
      }

      let parsed: unknown;
      try {
        parsed = parseJson(text);
      } catch (error) {
        if (!response.ok) {
          const code = canonicalCode(response.status);
          throw new HttpBotError(
            code,
            errorMessage(code),
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
        const code = canonicalCode(platformCode);
        throw new HttpBotError(
          code,
          errorMessage(code),
          response.status,
          platformCode,
          retryAfter(envelope, response),
        );
      }
      if (!Object.hasOwn(envelope, "result") || envelope.result === null) {
        throw new HttpBotError(
          "invalid-response",
          "LO Bot API response contained no result.",
          response.status,
        );
      }
      return normalizeResult(operation, input, envelope.result);
    },
  };
}
