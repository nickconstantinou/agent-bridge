import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { renderAgentBridgeContext } from "../src/contextCommand.js";

describe("agent-bridge-context helper", () => {
  function makeDb() {
    const path = join(tmpdir(), `agent-bridge-context-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    return { db, path };
  }

  it("renders the latest summary for the scoped chat key", () => {
    const { db, path } = makeDb();
    try {
      db.addConvTurn("chat:1", "user", "older turn", "codex");
      db.addConvSummary("chat:1", 1, 1, "Current objective:\n- Keep continuity.");

      const output = renderAgentBridgeContext(["--summary"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat:1",
      });

      expect(output).toContain("Current objective:");
      expect(output).toContain("Keep continuity");
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  it("renders recent turns with a limit", () => {
    const { db, path } = makeDb();
    try {
      db.addConvTurn("chat:1", "user", "first", "codex");
      db.addConvTurn("chat:1", "assistant", "second", "codex");
      db.addConvTurn("chat:1", "user", "third", "codex");

      const output = renderAgentBridgeContext(["--recent", "2"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat:1",
      });

      expect(output).not.toContain("first");
      expect(output).toContain("Assistant: second");
      expect(output).toContain("User: third");
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  it("requires context env vars", () => {
    expect(() => renderAgentBridgeContext(["--summary"], {})).toThrow(/AGENT_BRIDGE_CONTEXT_DB/);
    expect(() => renderAgentBridgeContext(["--summary"], { AGENT_BRIDGE_CONTEXT_DB: "x" })).toThrow(/AGENT_BRIDGE_CHAT_KEY/);
  });
});
