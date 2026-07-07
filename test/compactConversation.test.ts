import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb, type BridgeDb } from "../src/db.js";
import { compactConversation } from "../src/compactConversation.js";

function compactJson(summaryMd: string, memoryCandidates: unknown[] = []): string {
  return JSON.stringify({ summary_md: summaryMd, memory_candidates: memoryCandidates });
}

describe("compactConversation", () => {
  let dbPath: string;
  let db: BridgeDb;

  beforeEach(() => {
    dbPath = join(tmpdir(), `compact-conversation-test-${Date.now()}-${Math.random()}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  const deps = (runCli: (...args: any[]) => Promise<string>) => ({
    db,
    runCli,
    botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
    cliKind: "claude",
  });

  it("returns no_turns when there is nothing to compact", async () => {
    const runCli = vi.fn().mockResolvedValue(compactJson("should not be called"));
    const result = await compactConversation("chat:1", deps(runCli));
    expect(result.outcome).toBe("no_turns");
    expect(runCli).not.toHaveBeenCalled();
  });

  it("stores the summary and prunes covered turns on success", async () => {
    db.addConvTurn("chat:1", "user", "fix the bug");
    db.addConvTurn("chat:1", "assistant", "fixed");

    const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- fix bug"));
    const result = await compactConversation("chat:1", deps(runCli));

    expect(result.outcome).toBe("compacted");
    expect(result.summaryMd).toBe("Current objective:\n- fix bug");
    expect(result.turnCount).toBe(2);

    const summary = db.getLatestConvSummary("chat:1");
    expect(summary?.summary_md).toBe("Current objective:\n- fix bug");
    expect(db.getRecentConvTurns("chat:1", 100)).toEqual([]);
  });

  it("promotes valid memory candidates and counts rejected ones separately", async () => {
    db.addConvTurn("chat:1", "user", "remember this decision");

    const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- noted", [
      { type: "decision", scope: "project", text: "Use compact-first memory architecture.", confidence: 0.9 },
      { type: "not-a-real-type", scope: "project", text: "invalid type candidate" },
    ]));
    const result = await compactConversation("chat:1", deps(runCli));

    expect(result.outcome).toBe("compacted");
    expect(result.promotedMemoryIds).toHaveLength(1);
    expect(result.rejectedCandidateCount).toBe(1);
    expect(db.searchMemories("compact-first memory architecture").length).toBeGreaterThan(0);
  });

  it("does not store a summary or prune turns when the CLI call fails", async () => {
    db.addConvTurn("chat:1", "user", "hello");
    db.addConvTurn("chat:1", "assistant", "hi");

    const runCli = vi.fn().mockRejectedValue(new Error("CLI timeout"));
    const result = await compactConversation("chat:1", deps(runCli));

    expect(result.outcome).toBe("failed");
    expect(result.error).toBeTruthy();
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(2);
  });

  it("does not store a summary or prune turns when the CLI returns non-JSON/invalid output", async () => {
    db.addConvTurn("chat:1", "user", "hello");
    db.addConvTurn("chat:1", "assistant", "hi");

    const runCli = vi.fn().mockResolvedValue("Sure, here is a prose summary with no JSON structure.");
    const result = await compactConversation("chat:1", deps(runCli));

    expect(result.outcome).toBe("failed");
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(2);
  });

  it("merges chunked summaries with a previous summary via the reduce path", async () => {
    process.env.BRIDGE_COMPACT_CHUNK_MAX_CHARS = "80";
    try {
      for (let i = 0; i < 6; i++) {
        db.addConvTurn("chat:1", i % 2 === 0 ? "user" : "assistant", `turn-${i} ${"x".repeat(40)}`);
      }
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        const prompt = args[args.length - 1];
        if (prompt.includes("Merge these compact summaries")) {
          return compactJson("Current objective:\n- merged all chunks");
        }
        return compactJson("Current objective:\n- chunk summary");
      });
      const result = await compactConversation("chat:1", deps(runCli));

      expect(result.outcome).toBe("compacted");
      expect(result.summaryMd).toBe("Current objective:\n- merged all chunks");
      expect(runCli.mock.calls.length).toBeGreaterThan(1);
    } finally {
      delete process.env.BRIDGE_COMPACT_CHUNK_MAX_CHARS;
    }
  });

  it("honors the companion compact profile in the prompt sent to the CLI", async () => {
    db.addConvTurn("chat:1", "user", "remind me about my training plan");

    let capturedPrompt = "";
    const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      capturedPrompt = args[args.length - 1];
      return compactJson("Current objective:\n- track training");
    });
    const result = await compactConversation("chat:1", {
      ...deps(runCli),
      compactProfile: "companion",
    });

    expect(result.outcome).toBe("compacted");
    expect(capturedPrompt).toContain("preferences");
  });
});
