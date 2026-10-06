import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { parseLoBotWebhookUpdate } from "@lo-ink/bot-sdk";

/** Authenticate before decoding; bound concurrent requests and acknowledge durable work. */
export function createSecretaryWebhookServer({ secret, processUpdate }) {
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(secret))
    throw new Error("Invalid webhook secret.");
  const expected = Buffer.from(secret);
  let active = 0;
  const server = createServer(async (request, response) => {
    const finish = (status) => {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(status);
        response.end();
      }
    };
    if (request.method !== "POST" || request.url !== "/secretary")
      return finish(404);
    const header = request.headers["x-telegram-bot-api-secret-token"];
    const actual =
      typeof header === "string" ? Buffer.from(header) : Buffer.alloc(0);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return finish(401);
    if (
      !/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")
    )
      return finish(415);
    if (active >= 8) return finish(503);
    active++;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 2 << 20) {
          finish(413);
          request.resume();
          return;
        }
        chunks.push(chunk);
      }
      const update = parseLoBotWebhookUpdate(
        Buffer.concat(chunks).toString("utf8"),
      );
      await processUpdate(update);
      finish(200);
    } catch (error) {
      finish(error.code === "invalid-response" ? 400 : 503);
    } finally {
      active--;
    }
  });
  server.requestTimeout = 40000;
  server.headersTimeout = 10000;
  return server;
}
