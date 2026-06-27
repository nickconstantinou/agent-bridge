import { describe, it, expect } from "vitest";
import {
  buildCompactSummaryPrompt,
  buildTombstone,
  COMPACT_PROMPT_MAX_CHARS,
  COMPACT_TIMEOUT_MS,
  COMPACT_CHUNK_MAX_CHARS,
  COMPACT_PARALLELISM,
} from "../src/compactSummary.js";

describe("buildCompactSummaryPrompt", () => {
  it("includes the system header", () => {
    const prompt = buildCompactSummaryPrompt([
      { role: "user", text: "hello" },
      { role: "assistant", text: "world" },
    ]);
    expect(prompt).toContain("Current objective:");
    expect(prompt).toContain("Durable facts:");
    expect(prompt).toContain("Open state:");
  });

  it("includes turn content", () => {
    const prompt = buildCompactSummaryPrompt([
      { role: "user", text: "fix the bug" },
    ]);
    expect(prompt).toContain("fix the bug");
  });

  it("stays under maxChars", () => {
    const manyTurns = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: "x".repeat(200),
    }));
    const prompt = buildCompactSummaryPrompt(manyTurns);
    expect(prompt.length).toBeLessThanOrEqual(COMPACT_PROMPT_MAX_CHARS + 100); // small buffer for header
  });

  it("returns a non-empty string for empty turns", () => {
    const prompt = buildCompactSummaryPrompt([]);
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("Current objective:");
  });
});

describe("buildTombstone", () => {
  it("includes turn count", () => {
    const turns = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "world" },
    ];
    const t = buildTombstone(turns, "claude");
    expect(t).toContain("2 turns");
    expect(t).toContain("1 user");
    expect(t).toContain("1 assistant");
  });

  it("includes CLI name", () => {
    const t = buildTombstone([{ role: "user", text: "hi" }], "codex");
    expect(t).toContain("codex");
  });

  it("includes last user message", () => {
    const t = buildTombstone([
      { role: "assistant", text: "first" },
      { role: "user", text: "last user" },
    ], "claude");
    expect(t).toContain("last user");
  });

  it("handles empty turns", () => {
    const t = buildTombstone([], "claude");
    expect(t).toContain("0 turns");
    expect(t).toContain("none");
  });
});

describe("constants", () => {
  it("uses larger default compact chunks to reduce CLI round trips", () => {
    expect(COMPACT_PROMPT_MAX_CHARS).toBe(18_000);
    expect(COMPACT_CHUNK_MAX_CHARS).toBe(16_000);
    expect(COMPACT_PARALLELISM).toBe(2);
  });

  it("COMPACT_TIMEOUT_MS is 60000", () => {
    expect(COMPACT_TIMEOUT_MS).toBe(60_000);
  });
});
