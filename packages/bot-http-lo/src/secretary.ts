import {
  BotError,
  type SecretaryAttachment,
  type SecretaryFileReference,
  type SecretaryConnection,
  type SecretaryContext,
  type SecretaryMessage,
  type SecretaryDraft,
  type SecretaryOperations,
  type SecretaryRight,
  type SecretaryUpdate,
} from "@lo-ink/bot-sdk";

import { parseLosslessJson } from "./lossless-json.js";

function invalid(): never {
  throw new BotError("invalid-response", "Invalid LO secretary response.");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum = 9223372036854775807n): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : "";
  if (!/^[1-9][0-9]{0,18}$/.test(text) || BigInt(text) > maximum)
    return invalid();
  return text;
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ) ||
    value === "00000000-0000-0000-0000-000000000000"
  )
    return invalid();
  return value;
}
const rights = new Set<SecretaryRight>([
  "receive_messages",
  "send_messages",
  "mark_read",
  "edit_sent",
  "delete_sent",
  "delete_all",
]);
function connection(value: unknown, expectedId?: string): SecretaryConnection {
  const body = record(value);
  const id = uuid(body.id);
  const owner = record(body.user);
  const list = body.lo_rights === null ? [] : body.lo_rights;
  if (
    (expectedId !== undefined && expectedId !== id) ||
    owner.is_bot !== false ||
    body.lo_schema_version !== 1 ||
    typeof body.is_enabled !== "boolean" ||
    typeof body.date !== "number" ||
    !Number.isSafeInteger(body.date) ||
    body.date <= 0 ||
    !Array.isArray(list) ||
    list.some(
      (value) =>
        typeof value !== "string" || !rights.has(value as SecretaryRight),
    ) ||
    new Set(list).size !== list.length
  )
    return invalid();
  return {
    id,
    ownerId: integer(owner.id, 999999999999999n),
    policyVersion: integer(body.lo_policy_version),
    schemaVersion: 1,
    enabled: body.is_enabled,
    createdAt: body.date,
    rights: list as SecretaryRight[],
  };
}
function context(value: unknown): SecretaryContext {
  const body = record(value);
  return {
    conversationId: integer(body.conversation_id, 2147483647n),
    chatId: integer(body.chat_id, 999999999999999n),
    policyVersion: integer(body.policy_version),
    sourceMessageId: integer(body.source_message_id),
    sourceRevision: integer(body.source_revision),
  };
}
function descriptor(reference: string) {
  if (
    reference.length > 4096 ||
    !/^secretary-v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]{22}$/.test(reference)
  )
    return invalid();
  let decoded: unknown;
  try {
    const raw = atob(
      reference.split(":")[1]!.replaceAll("-", "+").replaceAll("_", "/"),
    );
    decoded = parseLosslessJson(
      new TextDecoder().decode(
        Uint8Array.from(raw, (character) => character.charCodeAt(0)),
      ),
    );
  } catch {
    return invalid();
  }
  const body = record(decoded),
    scope = record(body.scope);
  if (
    scope.action !== "receive_messages" ||
    (scope.eventKind !== "created" && scope.eventKind !== "edited") ||
    typeof body.kind !== "string" ||
    (body.size !== undefined && typeof body.size !== "string")
  )
    return invalid();
  return {
    key: JSON.stringify({
      botId: integer(scope.botId, 9007199254740991n),
      connectionId: uuid(scope.connectionId),
      conversationId: integer(scope.conversationId, 2147483647n),
      chatId: integer(scope.peerId, 999999999999999n),
      policyVersion: integer(scope.policyVersion),
      sourceMessageId: integer(scope.sourceMessageId),
      sourceRevision: integer(scope.sourceRevision),
      credentialVersion: integer(scope.credentialVersion),
      eventAt: integer(scope.eventAt),
      eventKind: scope.eventKind,
      kind: body.kind,
      mediaId:
        typeof body.mediaId === "number" && body.mediaId < 0
          ? String(body.mediaId)
          : integer(body.mediaId),
      size: body.size ?? "",
    }),
    scope,
    kind: body.kind,
    expiresAt: body.expiresAt === undefined ? 0 : measure(body.expiresAt),
  };
}
function validateAttachmentContext(
  attachments: readonly SecretaryAttachment[],
  message: SecretaryMessage,
  context: SecretaryContext,
): void {
  for (const attachment of attachments)
    for (const file of attachment.kind === "photo"
      ? attachment.sizes
      : [attachment]) {
      const scoped = descriptor(file.fileId);
      if (
        scoped.expiresAt !== 0 ||
        scoped.kind !==
          (attachment.kind === "document" ? "file" : attachment.kind) ||
        uuid(scoped.scope.connectionId) !== message.connectionId ||
        integer(scoped.scope.conversationId) !== context.conversationId ||
        integer(scoped.scope.peerId) !== context.chatId ||
        integer(scoped.scope.policyVersion) !== context.policyVersion ||
        integer(scoped.scope.sourceMessageId) !== context.sourceMessageId ||
        integer(scoped.scope.sourceRevision) !== context.sourceRevision
      )
        return invalid();
    }
}
function measure(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return invalid();
  return value;
}
function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return invalid();
  return value;
}
function reference(value: Record<string, unknown>): SecretaryFileReference {
  if (
    typeof value.file_id !== "string" ||
    value.file_id.length > 4096 ||
    !/^secretary-v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]{22}$/.test(value.file_id) ||
    typeof value.file_unique_id !== "string" ||
    !/^secretary:[a-f0-9]{64}$/.test(value.file_unique_id)
  )
    return invalid();
  return {
    fileId: value.file_id,
    uniqueId: value.file_unique_id,
    ...(value.mime_type !== undefined
      ? { mimeType: optionalText(value.mime_type) }
      : {}),
    ...(value.file_size !== undefined
      ? { sizeBytes: measure(value.file_size) }
      : {}),
  };
}
function attachments(value: unknown): readonly SecretaryAttachment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10)
    return invalid();
  return value.map((item) => {
    const entry = record(item);
    if (entry.kind === "photo") {
      if (
        !Array.isArray(entry.photo) ||
        entry.photo.length < 1 ||
        entry.photo.length > 4
      )
        return invalid();
      return {
        kind: "photo",
        sizes: entry.photo.map((item) => {
          const size = record(item);
          return {
            ...reference(size),
            width: measure(size.width),
            height: measure(size.height),
          };
        }),
      };
    }
    const kind = entry.kind;
    if (
      kind !== "document" &&
      kind !== "voice" &&
      kind !== "audio" &&
      kind !== "video"
    )
      return invalid();
    const body = record(entry[kind]);
    const file = reference(body);
    if (kind === "document")
      return {
        ...file,
        kind,
        ...(body.file_name !== undefined
          ? { fileName: optionalText(body.file_name) }
          : {}),
      };
    const durationSeconds = measure(body.duration);
    if (kind === "voice") return { ...file, kind, durationSeconds };
    if (kind === "audio")
      return {
        ...file,
        kind,
        durationSeconds,
        ...(body.title !== undefined
          ? { title: optionalText(body.title) }
          : {}),
        ...(body.performer !== undefined
          ? { performer: optionalText(body.performer) }
          : {}),
      };
    return {
      ...file,
      kind,
      durationSeconds,
      ...(body.width !== undefined ? { width: measure(body.width) } : {}),
      ...(body.height !== undefined ? { height: measure(body.height) } : {}),
    };
  });
}
function message(
  value: unknown,
  expectedConnection?: string,
  expectedChat?: string,
): SecretaryMessage {
  const body = record(value);
  const chat = record(body.chat);
  const from = record(body.from);
  const id = uuid(body.business_connection_id);
  const chatId = integer(chat.id, 999999999999999n);
  if (
    chat.type !== "private" ||
    from.is_bot !== false ||
    (expectedConnection !== undefined && id !== expectedConnection) ||
    (expectedChat !== undefined && chatId !== expectedChat) ||
    typeof body.date !== "number" ||
    !Number.isSafeInteger(body.date) ||
    body.date <= 0 ||
    (body.text !== undefined && typeof body.text !== "string")
  )
    return invalid();
  const replyToMessageId =
    body.lo_reply_to_message_id === undefined
      ? undefined
      : integer(body.lo_reply_to_message_id);
  let quote: { text: string; offsetUtf16: number } | undefined;
  if (body.lo_quote !== undefined) {
    const selected = record(body.lo_quote);
    if (
      !replyToMessageId ||
      typeof selected.text !== "string" ||
      !selected.text.trim() ||
      selected.text.length > 1024 ||
      typeof selected.offsetUtf16 !== "number" ||
      !Number.isInteger(selected.offsetUtf16) ||
      selected.offsetUtf16 < 0 ||
      selected.offsetUtf16 > 2147483647
    )
      return invalid();
    quote = { text: selected.text, offsetUtf16: selected.offsetUtf16 };
  }
  const caption = optionalText(body.caption);
  const mediaStatus = body.lo_media_status;
  if (
    mediaStatus !== undefined &&
    mediaStatus !== "available" &&
    mediaStatus !== "unavailable" &&
    mediaStatus !== "unsupported"
  )
    return invalid();
  const media =
    body.lo_attachments === undefined
      ? undefined
      : attachments(body.lo_attachments);
  if (
    (media !== undefined && mediaStatus !== "available") ||
    (mediaStatus === "available" && media === undefined)
  )
    return invalid();
  const mediaFileIds =
    body.lo_media_references === undefined
      ? undefined
      : body.lo_media_references;
  if (
    mediaFileIds !== undefined &&
    (!Array.isArray(mediaFileIds) ||
      mediaFileIds.length < 1 ||
      mediaFileIds.length > 10 ||
      new Set(mediaFileIds).size !== mediaFileIds.length ||
      mediaFileIds.some((value) => typeof value !== "string"))
  )
    return invalid();
  if (Array.isArray(mediaFileIds))
    for (const reference of mediaFileIds) {
      if (descriptor(reference as string).expiresAt !== 0) return invalid();
    }
  const albumId = body.lo_album_id;
  if (
    albumId !== undefined &&
    (typeof albumId !== "string" ||
      (media?.length ??
        (Array.isArray(mediaFileIds) ? mediaFileIds.length : 0)) < 2 ||
      !albumId.startsWith(id + ":" + integer(body.message_id) + ":") ||
      !/^[1-9][0-9]{0,18}$/.test(albumId.slice(albumId.lastIndexOf(":") + 1)))
  )
    return invalid();
  const actor =
    body.lo_secretary_bot_id === undefined
      ? undefined
      : integer(body.lo_secretary_bot_id, 9007199254740991n);
  if (actor !== undefined && BigInt(actor) < 1000000000000000n)
    return invalid();
  return {
    id: integer(body.message_id),
    conversationId: chatId,
    connectionId: id,
    senderId: integer(from.id, 999999999999999n),
    ...(actor ? { secretaryBotId: actor } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(quote ? { quote } : {}),
    ...(caption !== undefined ? { caption } : {}),
    ...(media ? { attachments: media } : {}),
    ...(Array.isArray(mediaFileIds)
      ? { mediaFileIds: mediaFileIds as string[] }
      : {}),
    ...(mediaStatus ? { mediaStatus } : {}),
    ...(typeof albumId === "string" ? { albumId } : {}),
    ...(typeof body.text === "string" ? { text: body.text } : {}),
  };
}

/** Decode the same typed event for polling and a verified webhook body. */
export function decodeSecretaryUpdate(
  body: Record<string, unknown>,
  updateId: string,
): SecretaryUpdate | null {
  const kinds = [
    "business_connection",
    "business_message",
    "edited_business_message",
    "deleted_business_messages",
  ].filter((key) => Object.hasOwn(body, key));
  if (!kinds.length) return null;
  if (
    kinds.length !== 1 ||
    ["message", "edited_message", "callback_query", "inline_query"].some(
      (key) => Object.hasOwn(body, key),
    )
  )
    return invalid();
  const kind = kinds[0]!;
  const value = record(body[kind]);
  if (kind === "business_connection")
    return {
      id: updateId,
      kind: "secretary_connection",
      connection: connection(value),
    };
  const scope = context(value.lo_context);
  if (
    typeof value.lo_event_id !== "string" ||
    !value.lo_event_id ||
    value.lo_event_id.length > 512
  )
    return invalid();
  const eventId = value.lo_event_id;
  if (kind === "deleted_business_messages") {
    const chat = record(value.chat);
    if (
      chat.type !== "private" ||
      integer(chat.id) !== scope.chatId ||
      !Array.isArray(value.message_ids) ||
      value.message_ids.length < 1 ||
      value.message_ids.length > 100
    )
      return invalid();
    const ids = value.message_ids.map((id) => integer(id));
    if (
      new Set(ids).size !== ids.length ||
      !ids.includes(scope.sourceMessageId)
    )
      return invalid();
    return {
      id: updateId,
      kind: "secretary_messages_deleted",
      eventId,
      context: scope,
      connectionId: uuid(value.business_connection_id),
      messageIds: ids,
    };
  }
  const incoming = message(value, undefined, scope.chatId);
  if (
    incoming.albumId !== undefined &&
    incoming.albumId !==
      incoming.connectionId + ":" + incoming.id + ":" + scope.sourceRevision
  )
    return invalid();
  if (incoming.id !== scope.sourceMessageId) return invalid();
  if (incoming.attachments)
    validateAttachmentContext(incoming.attachments, incoming, scope);
  return {
    id: updateId,
    kind:
      kind === "business_message"
        ? "secretary_message"
        : "secretary_message_edited",
    eventId,
    context: scope,
    message: incoming,
  };
}

export function wireSecretaryRequest<K extends keyof SecretaryOperations>(
  operation: K,
  input: SecretaryOperations[K]["input"],
): { method: string; body: Record<string, unknown> } {
  if (operation === "getFile") {
    const value = input as SecretaryOperations["getFile"]["input"];
    return { method: "getFile", body: { file_id: value.fileId } };
  }
  if (operation === "getConnection")
    return {
      method: "getBusinessConnection",
      body: {
        business_connection_id: (
          input as SecretaryOperations["getConnection"]["input"]
        ).connectionId,
      },
    };
  const value = input as SecretaryOperations["sendText"]["input"];
  const body: Record<string, unknown> = {
    business_connection_id: value.connectionId,
    lo_request_id: value.requestId,
    lo_context: {
      conversation_id: value.context.conversationId,
      chat_id: value.context.chatId,
      policy_version: value.context.policyVersion,
      source_message_id: value.context.sourceMessageId,
      source_revision: value.context.sourceRevision,
    },
  };
  switch (operation) {
    case "proposeDraft": {
      const draft = input as SecretaryOperations["proposeDraft"]["input"];
      return {
        method: "proposeBusinessDraft",
        body: {
          ...body,
          chat_id: draft.context.chatId,
          text: draft.text,
          lo_draft_reason: draft.reason,
        },
      };
    }
    case "sendText":
      return {
        method: "sendMessage",
        body: {
          ...body,
          chat_id: value.context.chatId,
          text: value.text,
          ...(value.quote === undefined
            ? {}
            : {
                lo_quote: {
                  text: value.quote.text,
                  offsetUtf16: value.quote.offsetUtf16,
                },
              }),
        },
      };
    case "sendMedia": {
      const media = input as SecretaryOperations["sendMedia"]["input"];
      for (const reference of media.fileIds) {
        const file = descriptor(reference),
          scope = file.scope;
        if (
          file.expiresAt !== 0 ||
          uuid(scope.connectionId) !== media.connectionId ||
          integer(scope.conversationId) !== media.context.conversationId ||
          integer(scope.peerId) !== media.context.chatId ||
          integer(scope.policyVersion) !== media.context.policyVersion ||
          integer(scope.sourceMessageId) !== media.context.sourceMessageId ||
          integer(scope.sourceRevision) !== media.context.sourceRevision
        )
          return invalid();
      }
      return {
        method: "sendBusinessMedia",
        body: {
          ...body,
          chat_id: media.context.chatId,
          lo_media: media.fileIds,
          caption: media.caption ?? "",
          ...(media.quote === undefined
            ? {}
            : {
                lo_quote: {
                  text: media.quote.text,
                  offsetUtf16: media.quote.offsetUtf16,
                },
              }),
        },
      };
    }
    case "editText": {
      const edit = input as SecretaryOperations["editText"]["input"];
      return {
        method: "editMessageText",
        body: {
          ...body,
          chat_id: value.context.chatId,
          message_id: edit.messageId,
          text: edit.text,
        },
      };
    }
    case "markRead":
      return {
        method: "readBusinessMessage",
        body: {
          ...body,
          chat_id: value.context.chatId,
          message_id: value.context.sourceMessageId,
        },
      };
    case "deleteMessages": {
      const deletion = input as SecretaryOperations["deleteMessages"]["input"];
      return {
        method: "deleteBusinessMessages",
        body: {
          ...body,
          message_ids: deletion.messageIds,
          ...(deletion.deleteAll === true ? { lo_delete_all: true } : {}),
        },
      };
    }
    default:
      throw new BotError("unsupported", "Unsupported secretary operation.");
  }
}
export function normalizeSecretaryResult<K extends keyof SecretaryOperations>(
  operation: K,
  input: SecretaryOperations[K]["input"],
  value: unknown,
): SecretaryOperations[K]["output"] {
  let result: SecretaryConnection | SecretaryMessage | SecretaryDraft | boolean;
  if (operation === "getFile") {
    const body = record(value);
    const expected = (input as SecretaryOperations["getFile"]["input"]).fileId;
    if (
      body.file_id !== expected ||
      typeof body.file_unique_id !== "string" ||
      !/^secretary:[a-f0-9]{64}$/.test(body.file_unique_id) ||
      typeof body.file_path !== "string" ||
      body.file_path.length > 4096 ||
      !/^secretary-v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]{22}$/.test(body.file_path) ||
      typeof body.lo_expires_at !== "number" ||
      !Number.isSafeInteger(body.lo_expires_at) ||
      body.lo_expires_at <= 0
    )
      return invalid();
    const original = descriptor(expected),
      download = descriptor(body.file_path);
    if (
      original.expiresAt !== 0 ||
      original.key !== download.key ||
      download.expiresAt !== body.lo_expires_at ||
      download.expiresAt <= 0
    )
      return invalid();
    return {
      fileId: expected,
      uniqueId: body.file_unique_id,
      path: body.file_path,
      expiresAt: body.lo_expires_at,
    } as SecretaryOperations[K]["output"];
  }
  if (operation === "getConnection")
    result = connection(
      value,
      (input as SecretaryOperations["getConnection"]["input"]).connectionId,
    );
  else if (operation === "proposeDraft") {
    const inputDraft = input as SecretaryOperations["proposeDraft"]["input"];
    const body = record(value);
    if (
      uuid(body.business_connection_id) !== inputDraft.connectionId ||
      integer(body.lo_conversation_id, 2147483647n) !==
        inputDraft.context.conversationId ||
      integer(body.chat_id, 999999999999999n) !== inputDraft.context.chatId ||
      integer(body.lo_source_message_id) !==
        inputDraft.context.sourceMessageId ||
      body.text !== inputDraft.text ||
      !["draft", "approved", "sent", "cancelled", "expired"].includes(
        String(body.state),
      ) ||
      !["review", "auto"].includes(String(body.mode)) ||
      ![
        "template",
        "manual_review",
        "cannot_answer",
        "owner_cancelled",
        "policy_changed",
        "source_changed",
        "manual_takeover",
        "superseded",
      ].includes(String(body.reason)) ||
      typeof body.date !== "number" ||
      !Number.isSafeInteger(body.date) ||
      body.date <= 0 ||
      typeof body.expires_at !== "number" ||
      !Number.isSafeInteger(body.expires_at) ||
      body.expires_at <= body.date ||
      (body.state === "sent") !== (body.message_id !== undefined) ||
      (body.mode === "auto" && body.state !== "sent")
    )
      return invalid();
    result = {
      id: uuid(body.lo_draft_id),
      connectionId: inputDraft.connectionId,
      conversationId: inputDraft.context.conversationId,
      chatId: inputDraft.context.chatId,
      sourceMessageId: inputDraft.context.sourceMessageId,
      revision: integer(body.lo_revision),
      state: body.state as SecretaryDraft["state"],
      mode: body.mode as SecretaryDraft["mode"],
      text: inputDraft.text,
      reason: body.reason as string,
      createdAt: body.date,
      expiresAt: body.expires_at,
      secretaryBotId: integer(body.lo_secretary_bot_id, 9007199254740991n),
      ...(body.message_id === undefined
        ? {}
        : { messageId: integer(body.message_id) }),
    } satisfies SecretaryDraft;
    if (BigInt((result as SecretaryDraft).secretaryBotId) < 1000000000000000n)
      return invalid();
  } else if (
    operation === "sendText" ||
    operation === "editText" ||
    operation === "sendMedia"
  ) {
    const action = input as SecretaryOperations["sendText"]["input"];
    result = message(value, action.connectionId, action.context.chatId);
    if (!result.secretaryBotId) return invalid();
    if (operation === "sendMedia") {
      const media = input as SecretaryOperations["sendMedia"]["input"];
      if (
        result.caption !== (media.caption ?? "") ||
        !result.mediaFileIds ||
        result.mediaFileIds.length !== media.fileIds.length ||
        result.mediaFileIds.some(
          (reference, index) => reference !== media.fileIds[index],
        )
      )
        return invalid();
    } else if (result.text !== action.text) return invalid();
    if (
      (operation === "sendText" || operation === "sendMedia") &&
      action.quote !== undefined &&
      (result.replyToMessageId !== action.context.sourceMessageId ||
        result.quote?.text !== action.quote.text ||
        result.quote?.offsetUtf16 !== action.quote.offsetUtf16)
    )
      return invalid();
    if (
      operation === "editText" &&
      result.id !==
        (input as SecretaryOperations["editText"]["input"]).messageId
    )
      return invalid();
  } else {
    if (value !== true) return invalid();
    result = true;
  }
  return result as SecretaryOperations[K]["output"];
}
