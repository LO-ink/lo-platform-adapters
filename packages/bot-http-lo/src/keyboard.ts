import {
  BotError,
  type ReplyMarkup,
  type ChatMenuButton,
} from "@lo-ink/bot-sdk";

/** Translate LO keyboard values only at the HTTP boundary. */
export function wireReplyMarkup(value: unknown): object {
  const input = value as ReplyMarkup;
  if ("removeKeyboard" in input)
    return {
      remove_keyboard: true,
      ...(input.selective !== undefined ? { selective: input.selective } : {}),
    };
  const button = (item: {
    text: string;
    url?: string;
    callbackData?: string;
    miniApp?: { url: string };
  }) => ({
    text: item.text,
    ...(item.url !== undefined ? { url: item.url } : {}),
    ...(item.callbackData !== undefined
      ? { callback_data: item.callbackData }
      : {}),
    ...(item.miniApp !== undefined ? { web_app: item.miniApp } : {}),
  });
  const result =
    "inlineKeyboard" in input
      ? { inline_keyboard: input.inlineKeyboard.map((row) => row.map(button)) }
      : {
          keyboard: input.keyboard.map((row) => row.map(button)),
          ...(input.resize !== undefined
            ? { resize_keyboard: input.resize }
            : {}),
          ...(input.oneTime !== undefined
            ? { one_time_keyboard: input.oneTime }
            : {}),
          ...(input.persistent !== undefined
            ? { is_persistent: input.persistent }
            : {}),
          ...(input.selective !== undefined
            ? { selective: input.selective }
            : {}),
          ...(input.placeholder !== undefined
            ? { input_field_placeholder: input.placeholder }
            : {}),
        };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 32768)
    throw new BotError(
      "invalid-input",
      "Serialized LO keyboard exceeds 32768 bytes.",
    );
  return result;
}
export function wireMenuButton(input: ChatMenuButton): object {
  return input.type === "miniApp"
    ? { type: "web_app", text: input.text, web_app: input.miniApp }
    : { type: input.type };
}
