import { execFileSync } from "node:child_process";
import { Parser } from "yaml";

const pythonTokenizer = `
import io, json, sys, tokenize
try:
    comments = [[token.start[0], token.string] for token in
                tokenize.generate_tokens(io.StringIO(sys.stdin.read()).readline)
                if token.type == tokenize.COMMENT]
except (tokenize.TokenError, IndentationError, SyntaxError):
    sys.exit(1)
print(json.dumps(comments))
`;

function goComments(source) {
  const comments = [];
  let offset = 0;
  let line = 1;
  while (offset < source.length) {
    const char = source[offset];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      offset++;
      while (offset < source.length) {
        const next = source[offset++];
        if (next === "\n") line++;
        if (next === quote) break;
        if (next === "\\" && quote !== "`") offset++;
      }
    } else if (
      source.startsWith("//", offset) ||
      source.startsWith("/*", offset)
    ) {
      const start = offset;
      const startLine = line;
      const block = source[offset + 1] === "*";
      const end = source.indexOf(block ? "*/" : "\n", offset + 2);
      offset = end < 0 ? source.length : end + (block ? 2 : 0);
      const text = source.slice(start, offset);
      comments.push([startLine, text]);
      line += text.split("\n").length - 1;
    } else {
      if (char === "\n") line++;
      offset++;
    }
  }
  return comments;
}

function yamlComments(source) {
  const comments = [];
  function visit(token) {
    if (!token || typeof token !== "object") return;
    if (token.type === "comment") {
      comments.push([
        source.slice(0, token.offset).split("\n").length,
        token.source,
      ]);
      return;
    }
    for (const value of Object.values(token)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  for (const token of new Parser().parse(source)) visit(token);
  return comments;
}

export function commentsIn(file, source) {
  if (/\.py$/.test(file)) {
    try {
      return JSON.parse(
        execFileSync("python3", ["-c", pythonTokenizer], {
          input: source,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
    } catch {
      throw new Error(
        `${file}: Python comment parsing requires Python 3 and valid source`,
      );
    }
  }
  if (/\.go$/.test(file)) return goComments(source);
  if (/\.ya?ml$/.test(file)) return yamlComments(source);
  return [];
}
