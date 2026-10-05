import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Telegraf, Input } from "telegraf";
import { Api, InputFile } from "grammy";

const token = "7:" + "A".repeat(43);
const bytes = Buffer.from("synthetic media fixture");
async function fixture(t) {
  const child = spawn(
    process.env.LO_STRICT_PYTHON ?? "python3",
    ["-u", fileURLToPath(new URL("./server.py", import.meta.url))],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Strict emulator startup timed out")),
      10_000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Strict emulator startup failed: " + stderr));
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("\n")) {
        clearTimeout(timer);
        resolve(output.trim());
      }
    });
  });
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  return base;
}
for (const framework of ["Telegraf", "grammY"]) {
  test(`${framework}: actual client requests are accepted or refused by the generated LO contract`, async (t) => {
    const base = await fixture(t);
    const api =
      framework === "Telegraf"
        ? new Telegraf(token, { telegram: { apiRoot: base } }).telegram
        : new Api(token, { apiRoot: base });
    const upload = (name) =>
      framework === "Telegraf"
        ? Input.fromBuffer(bytes, name)
        : new InputFile(bytes, name);
    assert.equal((await api.getMe()).can_read_all_group_messages, false);
    assert.equal((await api.sendMessage(42, "LO fixture")).text, "LO fixture");
    const photo = await api.sendPhoto(42, upload("photo.png"));
    assert.ok(photo.photo[0].file_id);
    const video = await api.sendVideo(42, upload("video.mp4"), {
      duration: 1,
      width: 1,
      height: 1,
    });
    assert.ok(video.video.file_id);
    const album = await api.sendMediaGroup(42, [
      { type: "photo", media: upload("a.png"), caption: "Album" },
      { type: "photo", media: upload("b.png") },
    ]);
    assert.equal(album.length, 2);
    assert.equal(album[0].message_id, album[1].message_id);
    const metadata = await api.getFile(video.video.file_id);
    assert.deepEqual(
      Buffer.from(
        await (
          await fetch(`${base}/file/bot${token}/${metadata.file_path}`)
        ).arrayBuffer(),
      ),
      bytes,
    );
    for (const [call, code] of [
      [
        () =>
          api.sendMessage(42, "Unsupported", { disable_notification: true }),
        400,
      ],
      [() => api.sendVideo(42, video.video.file_id, { duration: 1 }), 400],
      [
        () =>
          api.sendMediaGroup(42, [
            { type: "video", media: video.video.file_id },
            { type: "photo", media: photo.photo[0].file_id },
          ]),
        400,
      ],
      [() => api.sendChatAction(42, "typing"), 501],
    ])
      await assert.rejects(
        call,
        (error) => (error.response ?? error).error_code === code,
      );
  });
}
