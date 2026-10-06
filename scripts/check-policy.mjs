import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
  if (/\.(py|go)$/.test(file)) {
    for (const [index, line] of value.split("\n").entries()) {
      if (/^\s*(#|\/\/)/.test(line) && /[А-Яа-яЁё]/u.test(line))
        failures.push(`${file}:${index + 1}: comments must be in English`);
      if (/^\s*(#|\/\/).*(TODO|FIXME|HACK|XXX)\b/.test(line))
        failures.push(`${file}:${index + 1}: unfinished development note`);
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log("Repository policy passed.");
