import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("./check-policy.mjs", import.meta.url));
const russian =
  "\u043a\u043e\u043c\u043c\u0435\u043d\u0442\u0430\u0440\u0438\u0439";
function check(file, content) {
  const directory = mkdtempSync(join(tmpdir(), "lo-policy-"));
  try {
    execFileSync("git", ["init", "--quiet", directory]);
    writeFileSync(join(directory, file), content);
    const env = { ...process.env };
    delete env.GITHUB_EVENT_PATH;
    return spawnSync(process.execPath, [checker], {
      cwd: directory,
      env,
      encoding: "utf8",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("repository policy rejects actual trailing, block and document comments", () => {
  for (const text of [russian, "TODO", "FIXME", "HACK", "XXX"]) {
    for (const [file, source] of [
      ["example.py", `value = '# string' # ${text}\n`],
      ["example.go", `package fixture\nconst value = "// string" // ${text}\n`],
      ["block.go", `package fixture\n/*\n${text}\n*/\n`],
      ["workflow.yml", `name: checks # ${text}\n`],
      ["document.yaml", `--- # ${text}\nitems: [one, two]\n...\n`],
      ["stream.yaml", `name: first\n---\n# ${text}\nname: second\n`],
    ]) {
      const result = check(file, source);
      assert.equal(
        result.status,
        1,
        `${file}: ${result.stdout}${result.stderr}`,
      );
      assert.match(
        result.stderr,
        /comments must be in English|unfinished development note/,
      );
    }
  }
});

test("repository policy preserves international strings and YAML scalar contents", () => {
  for (const [file, source] of [
    [
      "example.py",
      `raw = r"# TODO ${russian}"\ntriple = '''# FIXME ${russian}'''\nescaped = "quote\\" # HACK ${russian}"\nvalue = f"# XXX {raw}"\n# English explanation\n`,
    ],
    [
      "example.go",
      `package fixture\nconst raw = \`/* TODO ${russian} */\`\nconst value = "\\" // FIXME ${russian}"\nconst runeValue = '/'\n// English explanation\n`,
    ],
    [
      "workflow.yml",
      `url: https://example.test/path#fragment\nquoted: '# TODO ${russian}'\ndouble: "# FIXME ${russian}"\nrun: |\n  # HACK ${russian}\nfolded: >\n  # XXX ${russian}\n# English explanation\n`,
    ],
  ]) {
    const result = check(file, source);
    assert.equal(result.status, 0, `${file}: ${result.stdout}${result.stderr}`);
  }
});
