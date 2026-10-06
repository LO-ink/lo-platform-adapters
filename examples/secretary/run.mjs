import { setTimeout as wait } from "node:timers/promises";
import { createBotClient, createSecretaryClient } from "@lo-ink/bot-sdk";
import { createLoHttpBotTransport } from "@lo-ink/bot-sdk";
import { openSecretaryState } from "./state.mjs";
import { createReferenceSecretary } from "./reference.mjs";
import { createSecretaryWebhookServer } from "./webhook.mjs";

function config() {
  if (!process.env.LO_BOT_TOKEN || !process.env.LO_SECRETARY_STATE)
    throw new Error("LO_BOT_TOKEN and LO_SECRETARY_STATE are required.");
  const mode = process.env.LO_SECRETARY_MODE ?? "poll";
  if (mode !== "poll" && mode !== "webhook")
    throw new Error("Use poll or webhook mode.");
  const bindings = JSON.parse(process.env.LO_SECRETARY_AUTO_CHATS ?? "[]");
  if (
    !Array.isArray(bindings) ||
    bindings.length > 1000 ||
    bindings.some(
      (value) =>
        !value ||
        typeof value.connectionId !== "string" ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(
          value.connectionId,
        ) ||
        typeof value.chatId !== "string" ||
        !/^[1-9][0-9]{0,14}$/.test(value.chatId),
    )
  )
    throw new Error("Invalid explicit per-chat opt-in.");
  const secret = process.env.LO_WEBHOOK_SECRET ?? "";
  if (mode === "webhook" && !/^[A-Za-z0-9_-]{32,128}$/.test(secret))
    throw new Error("Webhook mode requires a 32..128 character secret.");
  const port = Number(process.env.PORT ?? "8090");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid local port.");
  return { mode, bindings, secret, port };
}

async function main() {
  const options = config();
  const transport = createLoHttpBotTransport({
    token: process.env.LO_BOT_TOKEN,
    ...(process.env.LO_BOT_API_URL
      ? { baseUrl: process.env.LO_BOT_API_URL }
      : {}),
    allowInsecureLoopback: process.env.LO_ALLOW_LOOPBACK_HTTP === "1",
  });
  const bot = createBotClient(transport);
  const identity = await bot.getIdentity();
  const store = await openSecretaryState(
    process.env.LO_SECRETARY_STATE,
    identity.id,
  );
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const reference = createReferenceSecretary({
    store,
    client: createSecretaryClient(transport),
    bindings: options.bindings,
    signal: shutdown.signal,
    log: (code) => console.log(JSON.stringify({ secretary: code })),
  });
  try {
    if (options.mode === "poll") {
      // getUpdates owns the single stream; do not also configure a webhook.
      while (!shutdown.signal.aborted) {
        try {
          await reference.sweep();
          const updates = await bot.getUpdates(
            { offset: store.state.offset, limit: 50, waitSeconds: 25 },
            { signal: shutdown.signal },
          );
          for (const update of updates) {
            if (shutdown.signal.aborted) break;
            await reference.process(update);
            store.state.offset = (BigInt(update.id) + 1n).toString();
            await store.save();
          }
        } catch (error) {
          if (shutdown.signal.aborted) break;
          console.log(JSON.stringify({ secretary: "poll-retry" }));
          await wait(
            Math.min(
              60000,
              Math.max(1000, Number(error.retryAfterSeconds ?? 5) * 1000),
            ),
            undefined,
            { signal: shutdown.signal },
          ).catch(() => {});
        }
      }
    } else {
      const sweep = setInterval(() => {
        void reference
          .sweep()
          .catch(() =>
            console.log(JSON.stringify({ secretary: "retention-failed" })),
          );
      }, 60000);
      shutdown.signal.addEventListener("abort", () => clearInterval(sweep), {
        once: true,
      });
      const server = createSecretaryWebhookServer({
        secret: options.secret,
        processUpdate: (update) => reference.process(update),
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => {
        server.once("close", resolve);
        shutdown.signal.addEventListener("abort", () => server.close(), {
          once: true,
        });
        if (shutdown.signal.aborted) server.close();
      });
    }
  } finally {
    shutdown.abort();
    await reference.flush();
    await store.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
main().catch(() => {
  console.error(
    "Secretary reference bot stopped; inspect configuration and private state.",
  );
  process.exitCode = 1;
});
