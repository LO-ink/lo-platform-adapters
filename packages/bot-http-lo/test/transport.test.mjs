import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createBotClient } from "@lo/bot-sdk";
import { createLoHttpBotTransport, HttpBotError } from "../dist/index.js";

const token = "1000000000000042:test-token";

async function server(handler) {
  const instance = createServer(handler);
  await new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", resolve);
  });
  const address = instance.address();
  assert.equal(typeof address, "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        instance.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function reply(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(body);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function transport(baseUrl, options = {}) {
  return createLoHttpBotTransport({
    token,
    baseUrl,
    allowInsecureLoopback: true,
    ...options,
  });
}

test("maps every canonical operation to the exact LO method and body", async (t) => {
  const calls = [];
  const fixture = await server(async (request, response) => {
    calls.push({
      path: request.url,
      method: request.method,
      body: await body(request),
    });
    const method = request.url.slice(request.url.lastIndexOf("/") + 1);
    switch (method) {
      case "getMe":
        reply(
          response,
          200,
          '{"ok":true,"result":{"id":9007199254740993,"is_bot":true,"first_name":"Helper","username":"helper_bot","can_join_groups":false,"can_read_all_group_messages":false,"supports_inline_queries":false}}',
        );
        break;
      case "sendMessage":
        reply(
          response,
          200,
          '{"ok":true,"result":{"message_id":9007199254740995,"date":1,"chat":{"id":9007199254740993,"type":"private"},"text":"Hello"}}',
        );
        break;
      case "editMessageText":
        reply(
          response,
          200,
          '{"ok":true,"result":{"message_id":9007199254740995,"date":1,"edit_date":2,"chat":{"id":9007199254740993,"type":"private"},"text":"Updated"}}',
        );
        break;
      case "deleteMessage":
      case "setMyCommands":
        reply(response, 200, '{"ok":true,"result":true}');
        break;
      case "getMyCommands":
        reply(
          response,
          200,
          '{"ok":true,"result":[{"command":"start","description":"Start the bot"}]}',
        );
        break;
      case "getUpdates":
        reply(
          response,
          200,
          '{"ok":true,"result":[{"update_id":9007199254740997,"message":{"message_id":9007199254740999,"date":1,"chat":{"id":9007199254740993,"type":"private"},"text":"Incoming"}},{"update_id":9007199254741001,"callback_query":{"id":"opaque"}}]}',
        );
        break;
      default:
        reply(response, 404, '{"ok":false,"error_code":404}');
    }
  });
  t.after(fixture.close);

  const client = createBotClient(transport(fixture.url));
  assert.deepEqual(await client.getIdentity(), {
    id: "9007199254740993",
    name: "Helper",
    handle: "helper_bot",
  });
  assert.deepEqual(
    await client.sendMessage({
      conversationId: "9007199254740993",
      text: "Hello",
    }),
    {
      id: "9007199254740995",
      conversationId: "9007199254740993",
      text: "Hello",
    },
  );
  assert.equal(
    (
      await client.editMessage({
        conversationId: "9007199254740993",
        messageId: "9007199254740995",
        text: "Updated",
      })
    ).id,
    "9007199254740995",
  );
  assert.equal(
    await client.deleteMessage({
      conversationId: "9007199254740993",
      messageId: "9007199254740995",
    }),
    true,
  );
  assert.deepEqual(await client.getCommands(), [
    { name: "start", description: "Start the bot" },
  ]);
  assert.equal(
    await client.setCommands([{ name: "start", description: "Start the bot" }]),
    true,
  );
  assert.deepEqual(
    await client.getUpdates({
      offset: "9007199254740997",
      limit: 25,
      waitSeconds: 10,
    }),
    [
      {
        id: "9007199254740997",
        kind: "message",
        message: {
          id: "9007199254740999",
          conversationId: "9007199254740993",
          text: "Incoming",
        },
      },
      { id: "9007199254741001", kind: "unhandled" },
    ],
  );

  assert.deepEqual(
    calls.map(({ path, method }) => ({ path, method })),
    [
      "getMe",
      "sendMessage",
      "editMessageText",
      "deleteMessage",
      "getMyCommands",
      "setMyCommands",
      "getUpdates",
    ].map((name) => ({
      path: `/bot${token}/${name}`,
      method: "POST",
    })),
  );
  assert.deepEqual(
    calls.map((call) => call.body),
    [
      {},
      { chat_id: "9007199254740993", text: "Hello" },
      {
        chat_id: "9007199254740993",
        message_id: "9007199254740995",
        text: "Updated",
      },
      { chat_id: "9007199254740993", message_id: "9007199254740995" },
      {},
      { commands: [{ command: "start", description: "Start the bot" }] },
      { offset: "9007199254740997", limit: 25, timeout: 10 },
    ],
  );
});

test("preserves typed rate-limit guidance, never retries, and sanitizes server content", async (t) => {
  let calls = 0;
  const fixture = await server((_request, response) => {
    calls += 1;
    reply(
      response,
      429,
      `{"ok":false,"error_code":429,"description":"credential ${token}","parameters":{"retry_after":7}}`,
      { "retry-after": "9" },
    );
  });
  t.after(fixture.close);

  await assert.rejects(
    createBotClient(transport(fixture.url)).getIdentity(),
    (error) => {
      assert.ok(error instanceof HttpBotError);
      assert.equal(error.code, "rate-limited");
      assert.equal(error.status, 429);
      assert.equal(error.platformCode, 429);
      assert.equal(error.retryAfterSeconds, 7);
      assert.equal(String(error).includes(token), false);
      assert.equal(JSON.stringify(error).includes(token), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("maps conflict and unsupported responses to canonical errors", async (t) => {
  for (const [status, expected] of [
    [409, "conflict"],
    [501, "unsupported"],
  ]) {
    await t.test(String(status), async (t) => {
      const fixture = await server((_request, response) => {
        reply(
          response,
          status,
          `{"ok":false,"error_code":${status},"description":"not exposed"}`,
        );
      });
      t.after(fixture.close);
      await assert.rejects(
        createBotClient(transport(fixture.url)).getIdentity(),
        (error) => {
          assert.ok(error instanceof HttpBotError);
          assert.equal(error.code, expected);
          assert.equal(error.status, status);
          assert.equal(error.platformCode, status);
          return true;
        },
      );
    });
  }
});

test("forwards cancellation to fetch and returns a sanitized aborted error", async (t) => {
  let requestClosed;
  const closed = new Promise((resolve) => {
    requestClosed = resolve;
  });
  const fixture = await server((_request, response) => {
    response.once("close", requestClosed);
  });
  t.after(fixture.close);
  const controller = new AbortController();
  const pending = createBotClient(transport(fixture.url), {
    timeoutMs: 5_000,
  }).getIdentity({ signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    pending,
    (error) => error.code === "aborted" && !String(error).includes(token),
  );
  await Promise.race([
    closed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("request was not cancelled")), 1_000),
    ),
  ]);
});

test("refuses redirects before the credential can reach another server", async (t) => {
  let destinationCalls = 0;
  const destination = await server((_request, response) => {
    destinationCalls += 1;
    reply(response, 200, '{"ok":true,"result":{}}');
  });
  t.after(destination.close);
  const source = await server((_request, response) => {
    response.writeHead(307, { location: `${destination.url}/capture` });
    response.end();
  });
  t.after(source.close);

  await assert.rejects(
    createBotClient(transport(source.url)).getIdentity(),
    (error) => {
      assert.ok(error instanceof HttpBotError);
      assert.equal(error.status, 307);
      assert.equal(String(error).includes(token), false);
      return true;
    },
  );
  assert.equal(destinationCalls, 0);
});

test("rejects malformed success shapes without exposing raw content", async (t) => {
  const cases = [
    '{"ok":true}',
    '{"ok":true,"result":null}',
    '{"ok":true,"result":{"id":1,"is_bot":false,"first_name":"No"}}',
    '{"ok":true,"result":{"id":1,"is_bot":true,"first_name":"Incomplete"}}',
    `not json ${token}`,
  ];
  for (const responseBody of cases) {
    await t.test(responseBody.slice(0, 12), async (t) => {
      const fixture = await server((_request, response) =>
        reply(response, 200, responseBody),
      );
      t.after(fixture.close);
      await assert.rejects(
        createBotClient(transport(fixture.url)).getIdentity(),
        (error) => {
          assert.ok(error instanceof HttpBotError);
          assert.equal(error.code, "invalid-response");
          assert.equal(String(error).includes(token), false);
          return true;
        },
      );
    });
  }
});

test("rejects incomplete message wire objects", async (t) => {
  const responses = [
    '{"ok":true,"result":{"message_id":1,"chat":{"id":2,"type":"private"},"text":"Hello"}}',
    '{"ok":true,"result":{"message_id":1,"date":1,"chat":{"id":2,"type":"unknown"},"text":"Hello"}}',
  ];
  for (const responseBody of responses) {
    await t.test(
      responseBody.includes("unknown") ? "chat type" : "date",
      async (t) => {
        const fixture = await server((_request, response) =>
          reply(response, 200, responseBody),
        );
        t.after(fixture.close);
        await assert.rejects(
          createBotClient(transport(fixture.url)).sendMessage({
            conversationId: "2",
            text: "Hello",
          }),
          (error) =>
            error instanceof HttpBotError && error.code === "invalid-response",
        );
      },
    );
  }
});

test("plain HTTP is opt-in and restricted to exact loopback hosts", () => {
  for (const options of [
    { baseUrl: "http://127.0.0.1:8080" },
    { baseUrl: "http://example.com", allowInsecureLoopback: true },
    { baseUrl: "https://user:pass@example.com" },
    { baseUrl: "https://api.lo.ink?debug=1" },
    { baseUrl: "https://api.lo.ink#fragment" },
  ]) {
    assert.throws(
      () => createLoHttpBotTransport({ token, ...options }),
      (error) => {
        assert.ok(error instanceof HttpBotError);
        assert.equal(error.code, "invalid-input");
        assert.equal(String(error).includes(token), false);
        return true;
      },
    );
  }
  assert.throws(
    () => createLoHttpBotTransport({ token: "bad/token" }),
    HttpBotError,
  );
});

test("transport errors never expose the credential-bearing request URL", async () => {
  const failingFetch = async (url) => {
    throw new Error(`failed to fetch ${url}`);
  };
  await assert.rejects(
    createBotClient(
      createLoHttpBotTransport({ token, fetch: failingFetch }),
    ).getIdentity(),
    (error) => {
      assert.ok(error instanceof HttpBotError);
      assert.equal(error.code, "transport");
      assert.equal(String(error).includes(token), false);
      assert.equal(JSON.stringify(error).includes(token), false);
      return true;
    },
  );
});

test("captures the validated credential when the transport is constructed", async () => {
  const urls = [];
  const options = {
    token,
    fetch: async (url) => {
      urls.push(url);
      return new Response('{"ok":true,"result":[]}', { status: 200 });
    },
  };
  const client = createBotClient(createLoHttpBotTransport(options));
  options.token = "changed/credential";
  assert.deepEqual(await client.getCommands(), []);
  assert.deepEqual(urls, [`https://api.lo.ink/bot${token}/getMyCommands`]);
});

test("redirect body cleanup cannot expose transport details", async () => {
  const fetch = async () =>
    new Response(
      new ReadableStream({
        cancel() {
          throw new Error(`cleanup ${token}`);
        },
      }),
      { status: 307 },
    );
  await assert.rejects(
    createBotClient(createLoHttpBotTransport({ token, fetch })).getCommands(),
    (error) => {
      assert.ok(error instanceof HttpBotError);
      assert.equal(error.status, 307);
      assert.equal(String(error).includes(token), false);
      return true;
    },
  );
});
