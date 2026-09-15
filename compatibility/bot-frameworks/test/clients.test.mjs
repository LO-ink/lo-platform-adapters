import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Telegraf, Input } from "telegraf";
import { Api, InputFile, GrammyError } from "grammy";

// Deliberately invalid public fixture; never load a real bot credential in these tests.
const token = "123456:lo-fixture-token";
const fileContents = Buffer.from("fixture file contents");

async function fixture(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const parts = [];
      for await (const part of req) parts.push(part);
      const raw = Buffer.concat(parts);
      const request = {
        path: req.url,
        method: req.method,
        contentType: req.headers["content-type"] ?? "",
        raw,
      };
      if (request.contentType.startsWith("application/json"))
        request.body = JSON.parse(raw.toString());
      requests.push(request);
      if (req.url === `/file/bot${token}/files/sample.bin`) {
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(fileContents);
        return;
      }
      const method = req.url.slice(req.url.lastIndexOf("/") + 1);
      if (!req.url.startsWith(`/bot${token}/`))
        throw new Error("Unexpected path");
      res.setHeader("Content-Type", "application/json");
      if (request.body?.text?.startsWith("failure:")) {
        const code = Number(request.body.text.slice("failure:".length));
        res.statusCode = code;
        res.end(
          JSON.stringify({
            ok: false,
            error_code: code,
            description: "Fixture failure",
            ...(code === 429 ? { parameters: { retry_after: 7 } } : {}),
          }),
        );
        return;
      }
      const results = {
        getMe: {
          id: 123456,
          is_bot: true,
          first_name: "Example",
          username: "example_bot",
        },
        sendMessage: {
          message_id: 17,
          date: 1,
          chat: { id: 42, type: "private" },
          text: request.body?.text,
        },
        sendPhoto: {
          message_id: 18,
          date: 1,
          chat: { id: 42, type: "private" },
          photo: [
            {
              file_id: "photo-id",
              file_unique_id: "photo-unique",
              width: 1,
              height: 1,
            },
          ],
        },
        getFile: {
          file_id: "file-id",
          file_unique_id: "file-unique",
          file_path: "files/sample.bin",
        },
        setMyCommands: true,
        getMyCommands: [{ command: "start", description: "Start" }],
      };
      if (!(method in results)) {
        res.statusCode = 501;
        res.end(
          JSON.stringify({
            ok: false,
            error_code: 501,
            description: "Method is not supported",
          }),
        );
        return;
      }
      res.end(JSON.stringify({ ok: true, result: results[method] }));
    } catch {
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          ok: false,
          error_code: 500,
          description: "Invalid fixture request",
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return { base: `http://127.0.0.1:${server.address().port}`, requests };
}

test("Telegraf config preserves method roots, payloads, commands and file URLs", async (t) => {
  const { base, requests } = await fixture(t);
  const api = new Telegraf(token, { telegram: { apiRoot: base } }).telegram;
  assert.equal((await api.getMe()).username, "example_bot");
  assert.equal((await api.sendMessage("42", "Hello")).message_id, 17);
  await api.setMyCommands([{ command: "start", description: "Start" }]);
  assert.deepEqual(await api.getMyCommands(), [
    { command: "start", description: "Start" },
  ]);
  assert.equal(requests[1].path, `/bot${token}/sendMessage`);
  assert.equal(requests[1].body.chat_id, "42");
  assert.deepEqual(requests[2].body.commands, [
    { command: "start", description: "Start" },
  ]);
  const fileUrl = await api.getFileLink("file-id");
  assert.equal(fileUrl.href, `${base}/file/bot${token}/files/sample.bin`);
  assert.deepEqual(
    Buffer.from(await (await fetch(fileUrl)).arrayBuffer()),
    fileContents,
  );
});

test("grammY config preserves method roots and structured payloads", async (t) => {
  const { base, requests } = await fixture(t);
  const api = new Api(token, { apiRoot: base });
  assert.equal((await api.getMe()).username, "example_bot");
  assert.equal((await api.sendMessage("42", "Hello")).message_id, 17);
  await api.setMyCommands([{ command: "start", description: "Start" }]);
  assert.deepEqual(await api.getMyCommands(), [
    { command: "start", description: "Start" },
  ]);
  assert.equal(requests[1].path, `/bot${token}/sendMessage`);
  assert.equal(requests[1].body.chat_id, "42");
  assert.deepEqual(requests[2].body.commands, [
    { command: "start", description: "Start" },
  ]);
  assert.equal((await api.getFile("file-id")).file_path, "files/sample.bin");
});

for (const framework of ["telegraf", "grammy"]) {
  test(`${framework} sends multipart photos without a JSON-only shim`, async (t) => {
    const { base, requests } = await fixture(t);
    if (framework === "telegraf") {
      await new Telegraf(token, {
        telegram: { apiRoot: base },
      }).telegram.sendPhoto("42", Input.fromBuffer(fileContents, "sample.png"));
    } else {
      await new Api(token, { apiRoot: base }).sendPhoto(
        "42",
        new InputFile(fileContents, "sample.png"),
      );
    }
    assert.equal(requests.length, 1);
    assert.match(requests[0].contentType, /^multipart\/form-data; boundary=/);
    assert.match(requests[0].raw.toString(), /name="chat_id"/);
    assert.match(
      requests[0].raw.toString(),
      /filename=(?:"sample\.png"|sample\.png)(?:;|\r\n)/i,
    );
    assert.ok(requests[0].raw.includes(fileContents));
  });
  test(`${framework} exposes server errors and retry guidance without retrying`, async (t) => {
    const { base, requests } = await fixture(t);
    const api =
      framework === "telegraf"
        ? new Telegraf(token, { telegram: { apiRoot: base } }).telegram
        : new Api(token, { apiRoot: base });
    for (const code of [401, 404, 409, 429, 501]) {
      await assert.rejects(
        api.sendMessage("42", `failure:${code}`),
        (error) => {
          const response = framework === "telegraf" ? error.response : error;
          if (framework === "grammy") assert.ok(error instanceof GrammyError);
          assert.equal(response.error_code, code);
          if (code === 429) assert.equal(response.parameters.retry_after, 7);
          return true;
        },
      );
    }
    assert.equal(requests.length, 5);
  });
}
