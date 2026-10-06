import { execFileSync } from "node:child_process";
import { rmSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const workspace = realpathSync(process.cwd());
if (dirname(workspace) !== realpathSync(join(root, "packages")))
  throw new Error("Build must run inside an adapter workspace");
rmSync(join(workspace, "dist"), { recursive: true, force: true });
execFileSync(
  process.execPath,
  [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
  { cwd: workspace, stdio: "inherit" },
);
