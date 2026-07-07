import { describe, it, expect } from "vitest";
import {
  buildCompactSummaryPrompt,
  parseCompactOutput,
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

  it("requests structured JSON output with summary_md and memory_candidates", () => {
    const prompt = buildCompactSummaryPrompt([{ role: "user", text: "hi" }]);
    expect(prompt).toContain("summary_md");
    expect(prompt).toContain("memory_candidates");
    expect(prompt).toContain("JSON");
  });

  it("defaults to the engineering profile (repo/PR/file-path oriented guidance)", () => {
    const prompt = buildCompactSummaryPrompt([{ role: "user", text: "hi" }]);
    expect(prompt).toContain("repo");
    expect(prompt).toContain("PR");
  });

  it("companion profile asks for non-engineering durable facts instead of repo/PR framing", () => {
    const prompt = buildCompactSummaryPrompt([{ role: "user", text: "hi" }], "companion");
    expect(prompt).toContain("preferences");
    expect(prompt).not.toContain("active PR/issue numbers");
  });
});

describe("parseCompactOutput", () => {
  it("parses a valid JSON object with summary_md and memory_candidates", () => {
    const raw = JSON.stringify({
      summary_md: "Current objective:\n- ship feature",
      memory_candidates: [
        { type: "decision", scope: "project", text: "Use compact-first memory.", confidence: 0.9 },
      ],
    });
    const result = parseCompactOutput(raw);
    expect(result).not.toBeNull();
    expect(result?.summaryMd).toBe("Current objective:\n- ship feature");
    expect(result?.memoryCandidates).toHaveLength(1);
    expect(result?.memoryCandidates[0].text).toBe("Use compact-first memory.");
  });

  it("strips a markdown JSON fence before parsing", () => {
    const raw = [
      "```json",
      JSON.stringify({ summary_md: "Current objective:\n- fenced", memory_candidates: [] }),
      "```",
    ].join("\n");
    const result = parseCompactOutput(raw);
    expect(result?.summaryMd).toBe("Current objective:\n- fenced");
  });

  it("defaults memory_candidates to an empty array when missing", () => {
    const raw = JSON.stringify({ summary_md: "Current objective:\n- no candidates" });
    const result = parseCompactOutput(raw);
    expect(result?.memoryCandidates).toEqual([]);
  });

  it("filters out non-object entries from memory_candidates", () => {
    const raw = JSON.stringify({
      summary_md: "Current objective:\n- mixed",
      memory_candidates: [{ type: "note", scope: "project", text: "keep me" }, "not an object", 42, null],
    });
    const result = parseCompactOutput(raw);
    expect(result?.memoryCandidates).toHaveLength(1);
    expect(result?.memoryCandidates[0].text).toBe("keep me");
  });

  it("returns null when summary_md is missing", () => {
    const raw = JSON.stringify({ memory_candidates: [] });
    expect(parseCompactOutput(raw)).toBeNull();
  });

  it("returns null when summary_md is empty or not a string", () => {
    expect(parseCompactOutput(JSON.stringify({ summary_md: "" }))).toBeNull();
    expect(parseCompactOutput(JSON.stringify({ summary_md: 123 }))).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(parseCompactOutput("not json at all")).toBeNull();
    expect(parseCompactOutput("")).toBeNull();
  });

  it("returns null for valid JSON that is not an object (e.g. a bare array)", () => {
    expect(parseCompactOutput("[]")).toBeNull();
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
