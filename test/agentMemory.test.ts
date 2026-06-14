import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMemory, recallMemories } from "../src/agentMemory.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-memory-test-"));
  process.env.AGENT_MEMORY_DB_PATH = join(tmpDir, "test.sqlite");
});

afterEach(() => {
  delete process.env.AGENT_MEMORY_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("recallMemories — FTS5 ranked search", () => {
  it("returns memories ranked by relevance, not insertion order", async () => {
    // Insert 3x-matching record FIRST so it would lose under created_at DESC ordering
    addMemory({ type: "decision", scope: "project", text: "deployment deployment deployment is the core focus of our workflow." });
    await new Promise((r) => setTimeout(r, 5));
    addMemory({ type: "note", scope: "project", text: "The deployment pipeline runs nightly." });

    const results = recallMemories({ query: "deployment" });

    expect(results.length).toBeGreaterThanOrEqual(2);
    // FTS5: stronger match wins even though it was inserted earlier
    expect(results[0].text).toContain("deployment deployment deployment");
  });

  it("returns a score on each result", () => {
    addMemory({ type: "note", scope: "project", text: "FTS5 ranked search is fast." });

    const results = recallMemories({ query: "FTS5" });

    expect(results.length).toBe(1);
    expect(typeof results[0].score).toBe("number");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("falls back to LIKE when the query contains FTS5 syntax errors", () => {
    addMemory({ type: "note", scope: "project", text: 'use the "config" key for settings' });

    // A bare double-quote is an unclosed phrase — FTS5 syntax error
    // LIKE %"% still matches any text containing a quote
    const results = recallMemories({ query: '"' });

    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by scope using FTS5 path", () => {
    addMemory({ type: "note", scope: "project", text: "project scoped memory" });
    addMemory({ type: "note", scope: "personal", text: "personal scoped memory" });

    const results = recallMemories({ query: "scoped memory", scope: "project" });

    expect(results.every((r) => r.scope === "project")).toBe(true);
  });

  it("respects the limit using FTS5 path", () => {
    for (let i = 0; i < 5; i++) {
      addMemory({ type: "note", scope: "project", text: `entry ${i} about pipelines` });
    }

    const results = recallMemories({ query: "pipelines", limit: 3 });

    expect(results.length).toBe(3);
  });
});
