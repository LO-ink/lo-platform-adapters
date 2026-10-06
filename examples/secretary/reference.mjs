import { createHash } from "node:crypto";

const reply =
  "Hello! Your message has been received. The owner will reply when available.";
const hour = 3600000;
const terminal = new Set([
  "forbidden",
  "not-found",
  "conflict",
  "invalid-input",
  "unsupported",
]);
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** No AI. Drafts require review; only the server's separate owner opt-in sends automatically. */
export function createReferenceSecretary({
  store,
  client,
  bindings = [],
  now = Date.now,
  log = () => {},
  signal,
}) {
  const state = store.state;
  const optedIn = new Set(
    bindings.map((binding) => `${binding.connectionId}:${binding.chatId}`),
  );
  let tail = Promise.resolve();
  function cancelConnection(id) {
    for (const job of state.jobs)
      if (job.connectionId === id && job.status === "pending")
        job.status = "cancelled";
  }
  async function act(job) {
    if (job.status !== "pending") return;
    if (
      (optedIn.size > 0 &&
        !optedIn.has(`${job.connectionId}:${job.context.chatId}`)) ||
      now() - job.createdAt >= 24 * hour ||
      job.template !== 1
    ) {
      job.status = "cancelled";
      await store.save();
      return;
    }
    try {
      if (signal?.aborted)
        throw Object.assign(new Error("Secretary stopped."), {
          code: "aborted",
        });
      const connection = await client.getConnection(job.connectionId, {
        signal,
      });
      if (
        !connection.enabled ||
        connection.policyVersion !== job.context.policyVersion ||
        !connection.rights.includes("receive_messages") ||
        !connection.rights.includes("send_messages") ||
        connection.ownerId === job.context.chatId
      ) {
        cancelConnection(job.connectionId);
        await store.save();
        log("consent-unavailable");
        return;
      }
      const known = state.connections.find(
        (value) => value.id === connection.id,
      );
      if (known && known.ownerId !== connection.ownerId)
        throw new Error("Connection owner changed.");
      if (signal?.aborted)
        throw Object.assign(new Error("Secretary stopped."), {
          code: "aborted",
        });
      const draft = await client.proposeDraft(
        {
          connectionId: job.connectionId,
          context: job.context,
          requestId: job.requestId,
          text: reply,
          reason: job.reason ?? "template",
        },
        { signal },
      );
      job.status =
        draft.state === "sent"
          ? "sent"
          : draft.state === "draft"
            ? "drafted"
            : "cancelled";
      job.draftId = draft.id;
      if (draft.messageId) job.replyId = draft.messageId;
      await store.save();
      log(job.status);
    } catch (error) {
      if (terminal.has(error.code)) {
        cancelConnection(job.connectionId);
        await store.save();
        log("denied");
        return;
      }
      // No automatic write retry: caller preserves cursor and retries the same job.
      log("retry-required");
      throw error;
    }
  }
  function prune() {
    const timestamp = now();
    for (const job of state.jobs)
      if (job.status === "pending" && timestamp - job.createdAt >= 24 * hour)
        job.status = "cancelled";
    state.jobs = state.jobs.filter(
      (job) => timestamp - job.createdAt < 7 * 24 * hour,
    );
  }
  async function handle(update) {
    prune();
    const timestamp = now();
    if (update.kind === "secretary_connection") {
      const connection = update.connection;
      const existing = state.connections.find(
        (value) => value.id === connection.id,
      );
      if (existing && existing.ownerId !== connection.ownerId)
        throw new Error("Connection owner changed.");
      if (!existing && state.connections.length >= 256)
        throw new Error("Secretary connection limit reached.");
      if (existing)
        Object.assign(existing, {
          enabled: connection.enabled,
          policyVersion: connection.policyVersion,
        });
      else
        state.connections.push({
          id: connection.id,
          ownerId: connection.ownerId,
          enabled: connection.enabled,
          policyVersion: connection.policyVersion,
        });
      for (const job of state.jobs)
        if (
          job.connectionId === connection.id &&
          job.status === "pending" &&
          (!connection.enabled ||
            connection.policyVersion !== job.context.policyVersion)
        )
          job.status = "cancelled";
      await store.save();
      return;
    }
    if (
      update.kind === "secretary_message_edited" ||
      update.kind === "secretary_messages_deleted"
    ) {
      const connectionId = update.message?.connectionId ?? update.connectionId;
      const sourceIds = update.messageIds ?? [update.context.sourceMessageId];
      for (const job of state.jobs)
        if (
          job.connectionId === connectionId &&
          job.context.chatId === update.context.chatId &&
          sourceIds.includes(job.context.sourceMessageId) &&
          job.status === "pending"
        )
          job.status = "cancelled";
      await store.save();
      return;
    }
    if (
      update.kind !== "secretary_message" ||
      update.message.secretaryBotId ||
      update.message.senderId !== update.context.chatId ||
      (optedIn.size > 0 &&
        !optedIn.has(`${update.message.connectionId}:${update.context.chatId}`))
    )
      return;
    const key = hash([
      state.botId,
      update.message.connectionId,
      update.context.chatId,
      update.eventId,
    ]);
    let job = state.jobs.find((value) => value.key === key);
    if (job) {
      if (
        job.connectionId !== update.message.connectionId ||
        JSON.stringify(job.context) !== JSON.stringify(update.context)
      )
        throw new Error("Event context changed.");
      await act(job);
      return;
    }
    if (state.jobs.length >= 10000)
      throw new Error("Secretary event limit reached.");
    const recent = state.jobs.some(
      (value) =>
        value.connectionId === update.message.connectionId &&
        value.context.chatId === update.context.chatId &&
        timestamp - value.createdAt < 60000 &&
        (value.status === "pending" ||
          value.status === "drafted" ||
          value.status === "sent"),
    );
    job = {
      key,
      connectionId: update.message.connectionId,
      context: { ...update.context },
      requestId: hash([
        state.botId,
        update.message.connectionId,
        update.context.chatId,
        update.eventId,
        "template-1",
      ]),
      template: 1,
      reason:
        !update.message.text ||
        (update.message.attachments?.length ?? 0) > 0 ||
        (update.message.mediaStatus !== undefined &&
          update.message.mediaStatus !== "available")
          ? "cannot_answer"
          : "template",
      createdAt: timestamp,
      status: recent ? "cancelled" : "pending",
    };
    state.jobs.push(job);
    await store.save(); // Durable action identity before the first write.
    await act(job);
  }
  return {
    flush() {
      return tail;
    },
    sweep() {
      const task = tail.then(async () => {
        prune();
        await store.save();
      });
      tail = task.catch(() => {});
      return task;
    },
    process(update) {
      const task = tail.then(() => handle(update));
      tail = task.catch(() => {});
      return task;
    },
  };
}
