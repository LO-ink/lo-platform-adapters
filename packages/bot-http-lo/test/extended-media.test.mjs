import test from "node:test";
import assert from "node:assert/strict";
import { createBotClient, BadRequest, Unavailable } from "@lo-ink/bot-sdk";
import { createLoHttpBotTransport } from "../dist/index.js";
const token = "42:" + "A".repeat(43);
const message = (extra) => ({
  message_id: 1,
  date: 1,
  chat: { id: 42, type: "private" },
  ...extra,
});
function client(handler) {
  return createBotClient(
    createLoHttpBotTransport({
      token,
      fetch: async (url, options) => handler(url, options),
    }),
  );
}
test("video multipart uses parameter-named parts and serializes upload metadata", async () => {
  const bot = client((_url, options) => {
    const form = options.body;
    assert.ok(form instanceof FormData);
    assert.deepEqual(
      [...form.keys()],
      [
        "chat_id",
        "caption",
        "duration",
        "width",
        "height",
        "supports_streaming",
        "video",
        "thumbnail",
      ],
    );
    assert.equal(form.get("video").name, "clip.mp4");
    assert.equal(form.get("thumbnail").name, "poster.jpg");
    assert.equal(form.get("duration"), "3");
    assert.equal(form.get("supports_streaming"), "false");
    return Response.json({
      ok: true,
      result: message({ video: { file_id: "video-fixture" } }),
    });
  });
  const result = await bot.sendVideo({
    conversationId: "42",
    video: { data: new Uint8Array([1]), name: "clip.mp4" },
    caption: "Clip",
    duration: 3,
    width: 640,
    height: 360,
    supportsStreaming: false,
    thumbnail: { data: new Uint8Array([2]), name: "poster.jpg" },
  });
  assert.equal(result.fileId, "video-fixture");
});
test("cached audio and video use JSON and retain supportsStreaming without upload fields", async () => {
  const bot = client((url, options) => {
    const video = url.endsWith("sendVideo");
    assert.deepEqual(JSON.parse(options.body), {
      chat_id: "42",
      [video ? "video" : "audio"]: "fixture",
      ...(video ? { supports_streaming: false } : {}),
    });
    return Response.json({
      ok: true,
      result: message({ [video ? "video" : "audio"]: { file_id: "fixture" } }),
    });
  });
  await bot.sendVideo({
    conversationId: "42",
    video: { fileId: "fixture" },
    supportsStreaming: false,
  });
  await bot.sendAudio({ conversationId: "42", audio: { fileId: "fixture" } });
});
test("album uploads resolve only their named attachment references and keep LO shared message IDs", async () => {
  const bot = client((_url, options) => {
    const form = options.body,
      media = JSON.parse(form.get("media"));
    assert.deepEqual(media, [
      { type: "document", media: "attach://media_0", caption: "First" },
      { type: "document", media: "cached" },
    ]);
    assert.equal(form.get("media_0").name, "first.txt");
    return Response.json({
      ok: true,
      result: [
        message({ document: { file_id: "first" }, caption: "First" }),
        message({ document: { file_id: "cached" } }),
      ],
    });
  });
  const result = await bot.sendMediaGroup({
    conversationId: "42",
    media: [
      {
        type: "document",
        media: { data: new Uint8Array([1]), name: "first.txt" },
        caption: "First",
      },
      { type: "document", media: { fileId: "cached" } },
    ],
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].id, result[1].id);
  assert.equal(result[1].fileId, "cached");
});
test("getFile preserves an absent downloadable path instead of inventing one", async () => {
  const bot = client((_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { file_id: "fixture" });
    return Response.json({
      ok: true,
      result: { file_id: "fixture", file_unique_id: "unique" },
    });
  });
  assert.deepEqual(await bot.getFile("fixture"), {
    fileId: "fixture",
    uniqueId: "unique",
  });
});
test("downloads stream bounded bytes and never follow redirects carrying credentials", async () => {
  let cancelled = false;
  const bot = client((url, options) => {
    assert.equal(url, `https://api.lo.ink/file/bot${token}/files/fixture`);
    assert.equal(options.redirect, "manual");
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1, 2]));
          c.enqueue(new Uint8Array([3, 4]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const reader = (
    await bot.downloadFile({ path: "files/fixture", maxBytes: 3 })
  ).getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2]));
  await assert.rejects(reader.read(), { code: "invalid-response" });
  assert.equal(cancelled, true);
  const redirect = client(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.test/private" },
      }),
  );
  await assert.rejects(
    redirect.downloadFile({ path: "fixture" }),
    (e) => e.code === "transport" && !String(e).includes(token),
  );
});
test("download cancellation cancels the underlying producer", async () => {
  let cancelled = 0;
  const bot = client(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled++;
          },
        }),
      ),
  );
  const stream = await bot.downloadFile({ path: "fixture" });
  await stream.cancel();
  assert.equal(cancelled, 1);
});
test("descriptions never fabricate structured reasons; explicit fields are preserved", async () => {
  for (const [description] of [
    [
      "Bad Request: disable_notification is not supported yet",
      "unsupported_parameter",
      "disable_notification",
    ],
    [
      "Bad Request: duration applies only to an uploaded video, not to a file identifier",
      "upload_only",
      "duration",
    ],
    [
      "Bad Request: video must be a file identifier",
      "feature_disabled",
      "video",
    ],
  ]) {
    const bot = client(() =>
      Response.json(
        { ok: false, error_code: 400, description },
        { status: 400 },
      ),
    );
    await assert.rejects(
      bot.sendMessage({ conversationId: "42", text: "Fixture" }),
      (e) =>
        e instanceof BadRequest &&
        e.details.reason === undefined &&
        e.details.parameter === undefined,
    );
  }
  const bot = client(() =>
    Response.json(
      {
        ok: false,
        error_code: 400,
        description: "Old description",
        parameters: { reason: "upload_only", parameter: "width" },
      },
      { status: 400 },
    ),
  );
  await assert.rejects(
    bot.sendMessage({ conversationId: "42", text: "Fixture" }),
    (e) =>
      e.details.parameter === "width" && e.details.reason === "upload_only",
  );
});
test("invalid 503 JSON and HTML are unavailable; success parse failures stay invalid-response", async () => {
  for (const body of ["<html>private detail</html>", "[]", "{}"]) {
    const bot = client(() => new Response(body, { status: 503 }));
    await assert.rejects(bot.getIdentity(), Unavailable);
  }
  const bot = client(() => new Response("<html>detail</html>"));
  await assert.rejects(bot.getIdentity(), { code: "invalid-response" });
});

test("aborting a returned download releases a producer that ignores fetch cancellation", async () => {
  let cancelled = 0;
  const bot = client(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      ),
  );
  const controller = new AbortController();
  const reader = (
    await bot.downloadFile({ path: "fixture", signal: controller.signal })
  ).getReader();
  const pending = reader.read();
  controller.abort();
  await assert.rejects(pending, { code: "aborted" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

test("installation flags become native LO values and retain false separately from absence", async () => {
  const bot = client(() =>
    Response.json({
      ok: true,
      result: {
        id: 7,
        is_bot: true,
        first_name: "Fixture",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        capabilities: {
          video_uploads: false,
          audio_uploads: false,
          single_attach: true,
          media_groups: true,
          chat_actions: false,
        },
      },
    }),
  );
  assert.deepEqual(await bot.getCapabilities(), {
    videoUploads: false,
    audioUploads: false,
    singleAttach: true,
    mediaGroups: true,
    chatActions: false,
  });
});
