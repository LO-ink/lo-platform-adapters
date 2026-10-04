import { BotApiError, type BotUpdate, type Message } from "@lo-ink/bot-sdk";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
function invalid(): never {
  throw new BotApiError(
    "invalid-response",
    "LO Bot API returned an invalid interaction.",
  );
}

/** Service events need no fabricated stored-message identifier. */
export function interactionUpdate(
  raw: Record<string, unknown>,
  id: string,
  identifier: (value: unknown, positive?: boolean) => string | null,
  message: (value: unknown) => Message,
): BotUpdate | undefined {
  if (Object.hasOwn(raw, "callback_query")) {
    if (Object.hasOwn(raw, "message")) invalid();
    const callback = record(raw.callback_query),
      userId = identifier(record(callback?.from)?.id, true);
    if (
      !callback ||
      !userId ||
      typeof callback.id !== "string" ||
      !callback.id ||
      callback.id.length > 1024 ||
      callback.id.trim() !== callback.id ||
      /[\u0000-\u001f]/.test(callback.id) ||
      (callback.data !== undefined && typeof callback.data !== "string")
    )
      invalid();
    return {
      id,
      kind: "callback",
      callback: {
        id: callback.id,
        userId,
        ...(typeof callback.data === "string" ? { data: callback.data } : {}),
        ...(callback.message !== undefined
          ? { message: message(callback.message) }
          : {}),
      },
    };
  }
  const incoming = record(raw.message);
  if (!incoming || !Object.hasOwn(incoming, "web_app_data")) return undefined;
  const data = record(incoming.web_app_data),
    conversationId = identifier(record(incoming.chat)?.id);
  if (
    !data ||
    !conversationId ||
    typeof data.data !== "string" ||
    (data.button_text !== undefined && typeof data.button_text !== "string")
  )
    invalid();
  const userId = identifier(record(incoming.from)?.id, true),
    messageId = identifier(incoming.message_id, true);
  if (
    (incoming.from !== undefined && !userId) ||
    (incoming.message_id !== undefined && !messageId)
  )
    invalid();
  return {
    id,
    kind: "appData",
    appData: {
      conversationId,
      data: data.data,
      ...(userId ? { userId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(typeof data.button_text === "string"
        ? { buttonText: data.button_text }
        : {}),
    },
  };
}
