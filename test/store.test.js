import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStore } from "../src/store.js";

describe("file store", () => {
  it("writes atomically and preserves readable json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-bridge-store-"));
    const file = join(dir, "state.json");
    const store = createFileStore(file, { codex: 0, gemini: 0 });

    await store.write({ codex: 5 });
    const content = await readFile(file, "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
    expect(JSON.parse(content)).toEqual({ codex: 5, gemini: 0 });

    await rm(dir, { recursive: true, force: true });
  });

  it("recovers from corrupt json on read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-bridge-store-"));
    const file = join(dir, "state.json");
    await writeFile(file, "not-json");
    const store = createFileStore(file, { codex: 0, gemini: 0 });

    await expect(store.read()).resolves.toEqual({ codex: 0, gemini: 0 });

    await rm(dir, { recursive: true, force: true });
  });

  it("serializes concurrent writes without losing updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-bridge-store-"));
    const file = join(dir, "state.json");
    const storeA = createFileStore(file, { codex: 0, gemini: 0 });
    const storeB = createFileStore(file, { codex: 0, gemini: 0 });

    await Promise.all([
      storeA.write({ codex: 7 }),
      storeB.write({ gemini: 11 }),
    ]);

    await expect(storeA.read()).resolves.toEqual({ codex: 7, gemini: 11 });

    await rm(dir, { recursive: true, force: true });
  });
});
