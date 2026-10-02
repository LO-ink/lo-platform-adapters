import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

test("explicit LO examples start on partial hosts without loading a foreign script", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "lo-example-consumer-"));
  const keys = [
    "LO",
    "document",
    "matchMedia",
    "getComputedStyle",
    "addEventListener",
  ];
  const originals = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  try {
    symlinkSync(
      join(root, "node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    for (const [example, host] of [
      ["vanilla", "lo-native"],
      ["cross-platform", "lo-native"],
      ["cross-platform", "lo-legacy"],
    ]) {
      let readyCalls = 0;
      let scriptLoads = 0;
      let pagehide;
      const listeners = new Set();
      const port = {
        protocolVersion: 1,
        generation: "example:document",
        launchData: "lo-signed-bytes",
        operations: ["ready"],
        capabilities: ["ready"],
        snapshot: () => ({ colorScheme: "dark" }),
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        postMessage(raw) {
          const request = JSON.parse(raw);
          assert.equal(request.operation, "ready");
          readyCalls++;
          for (const listener of [...listeners])
            listener(
              JSON.stringify({
                channel: "lo.miniapp",
                version: 1,
                generation: port.generation,
                kind: "result",
                id: request.id,
                ok: true,
                value: null,
              }),
            );
        },
      };
      const rootElement = {
        dataset: { miniappHost: host },
        style: { setProperty() {} },
      };
      const globals = {
        LO:
          host === "lo-native"
            ? { MiniAppNative: port }
            : {
                WebApp: {
                  initData: "lo-signed-bytes",
                  capabilities: ["ready"],
                  ready() {
                    readyCalls++;
                  },
                },
              },
        document: {
          documentElement: rootElement,
          querySelector: () => null,
          createElement() {
            scriptLoads++;
            throw new Error("LO must not load another host's script");
          },
        },
        matchMedia: () => ({
          matches: false,
          addEventListener() {},
          removeEventListener() {},
        }),
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
        addEventListener(event, listener) {
          assert.equal(event, "pagehide");
          pagehide = listener;
        },
      };
      for (const [key, value] of Object.entries(globals))
        Object.defineProperty(globalThis, key, {
          value,
          configurable: true,
          writable: true,
        });
      const source = readFileSync(
        join(root, "examples", example + ".ts"),
        "utf8",
      );
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText;
      const file = join(directory, example + "-" + host + ".mjs");
      writeFileSync(file, compiled);
      await import(pathToFileURL(file).href);
      assert.equal(readyCalls, 1);
      assert.equal(scriptLoads, 0);
      assert.equal(typeof pagehide, "function");
      pagehide();
      assert.equal(listeners.size, 0);
    }
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
