import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";
import { handleCommand } from "../src/commands.js";
import type { BridgeConfig } from "../src/types.js";

function makeConfig(): BridgeConfig {
  const emptyBot = { token: undefined, command: "", modelPreference: [] };
  return {
    allowedUserIds: new Set(["42"]),
    serviceEnvFile: null,
    serviceKind: null,
    pollIntervalMs: 1000,
    executionMode: "safe",
    asyncEnabled: false,
    dbPath: ":memory:",
    bots: { codex: emptyBot, antigravity: emptyBot, claude: emptyBot, kimchi: emptyBot },
  };
}

describe("/context operator diagnostics", () => {
  let db: BridgeDb;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    delete process.env.BRIDGE_CONTEXT_INJECTION_POLICY;
    delete process.env.BRIDGE_PRESEED_COMPACT_MODE;
    delete process.env.BRIDGE_PRESEED_COMPACT_CHARS;
    db.close();
  });

  it("shows the always policy and off pre-seed mode by default", () => {
    const result = handleCommand("claude", "/context", { db, chatId: "100", config: makeConfig() });
    expect(result?.kind).toBe("message");
    const text = (result as any).text as string;
    expect(text).toContain("Injection policy: always");
    expect(text).toContain("Pre-seed compact: off");
  });

  it("shows the configured handoff_once policy and auto pre-seed threshold", () => {
    process.env.BRIDGE_CONTEXT_INJECTION_POLICY = "handoff_once";
    process.env.BRIDGE_PRESEED_COMPACT_MODE = "auto";
    process.env.BRIDGE_PRESEED_COMPACT_CHARS = "12345";

    const result = handleCommand("claude", "/context", { db, chatId: "100", config: makeConfig() });
    const text = (result as any).text as string;

    expect(text).toContain("Injection policy: handoff_once");
    expect(text).toContain("Pre-seed compact: auto (threshold 12345 chars)");
  });

  it("shows uncompacted turn/char counts and memory count", () => {
    db.addConvTurn("100", "user", "hello there");
    db.addConvTurn("100", "assistant", "hi");
    db.addMemory({ id: "mem-1", type: "decision", text: "some durable fact" });

    const result = handleCommand("claude", "/context", { db, chatId: "100", config: makeConfig() });
    const text = (result as any).text as string;

    expect(text).toContain("Uncompacted: 2 turns, 13 chars");
    expect(text).toContain("Memory count: 1");
  });

  it("reports zero uncompacted turns and zero memory count for a fresh chat", () => {
    const result = handleCommand("claude", "/context", { db, chatId: "brand-new-chat", config: makeConfig() });
    const text = (result as any).text as string;

    expect(text).toContain("Uncompacted: 0 turns, 0 chars");
    expect(text).toContain("Memory count: 0");
  });
});
