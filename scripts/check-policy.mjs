import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { commentsIn } from "./comment-reader.mjs";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const retired = ["https://github.com/", "zaytcevcom/", "lo-miniapp-sdk"].join(
  "",
);
const failures = [];
for (const file of new Set(files)) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  if (bytes.includes(0)) continue;
  const value = bytes.toString("utf8");
  if (value.includes(retired)) failures.push(`${file}: retired repository URL`);
  if (
    (/(^|\/)readme[^/]*\.md$/i.test(file) || /^docs\/.*\.md$/.test(file)) &&
    /[А-Яа-яЁё]/u.test(value)
  )
    failures.push(`${file}: documentation must be in English`);
  for (const [line, comment] of commentsIn(file, value)) {
    if (/[А-Яа-яЁё]/u.test(comment))
      failures.push(`${file}:${line}: comments must be in English`);
    if (/\b(TODO|FIXME|HACK|XXX)\b/.test(comment))
      failures.push(`${file}:${line}: unfinished development note`);
  }
}
if (process.env.GITHUB_EVENT_PATH) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const head = event.pull_request?.head.sha ?? process.env.GITHUB_SHA;
  const base = event.pull_request?.base.sha ?? event.before;
  const validSha = (value) =>
    typeof value === "string" &&
    /^[a-f0-9]{40}$/.test(value) &&
    !/^0+$/.test(value);
  if (!validSha(head)) throw new Error("Missing CI commit identity");
  const range = validSha(base) ? `${base}..${head}` : head;
  const args = validSha(base)
    ? ["log", "--format=%B", range]
    : ["log", "-1", "--format=%B", range];
  const messages = execFileSync("git", args, { encoding: "utf8" });
  if (/[А-Яа-яЁё]/u.test(messages))
    failures.push("New commit messages must be in English");
  if (messages.includes(retired))
    failures.push("New commit messages contain the retired repository URL");
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log("Repository policy passed.");
