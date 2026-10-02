import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** One process, private atomic state; never persist incoming text or credentials. */
export async function openSecretaryState(filename, botId) {
  const path = resolve(filename);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = await open(`${path}.lock`, "wx", 0o600);
  await lock.writeFile(String(process.pid));
  await lock.sync();
  let state;
  try {
    try {
      const file = await open(path, "r");
      try {
        const stat = await file.stat();
        if (stat.size > 16 << 20 || (stat.mode & 0o077) !== 0)
          throw new Error("Unsafe secretary state file.");
        state = JSON.parse(await file.readFile("utf8"));
      } finally {
        await file.close();
      }
      if (
        state.schema !== 1 ||
        state.botId !== botId ||
        !Array.isArray(state.jobs) ||
        !Array.isArray(state.connections) ||
        state.jobs.length > 10000 ||
        state.connections.length > 256 ||
        typeof state.offset !== "string" ||
        !/^[0-9]+$/.test(state.offset)
      )
        throw new Error("Incompatible secretary state.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = { schema: 1, botId, offset: "0", connections: [], jobs: [] };
    }
  } catch (error) {
    await lock.close();
    await rm(`${path}.lock`, { force: true });
    throw error;
  }
  let closed = false;
  return {
    state,
    async save() {
      if (closed) throw new Error("Secretary state is closed.");
      const temporary = `${path}.tmp-${process.pid}`;
      const file = await open(temporary, "w", 0o600);
      try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await lock.close();
      await rm(`${path}.lock`, { force: true });
    },
  };
}
