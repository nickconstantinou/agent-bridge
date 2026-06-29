import { describe, expect, it, vi } from "vitest";
import { extractProjectMemorySidecars, storeProjectMemoryCandidate } from "../src/projectMemory.js";
import { buildPostTurnMemoryExtractionPrompt, parsePostTurnMemoryCandidates } from "../src/memoryExtractor.js";

describe("project memory sidecar extraction", () => {
  it("does not strip sidecar examples inside fenced code blocks", () => {
    const text = [
      "Use this format:",
      "",
      "```html",
      "<!-- agent-bridge-memory",
      JSON.stringify([{ type: "decision", scope: "project", text: "Example only, do not store." }]),
      "-->",
      "```",
      "",
      "End.",
    ].join("\n");

    const extracted = extractProjectMemorySidecars(text);

    expect(extracted.cleanText).toContain("agent-bridge-memory");
    expect(extracted.candidates).toEqual([]);
  });
});

describe("project memory storage", () => {
  it("stores validated candidates through the BridgeDb project-memory abstraction", () => {
    const db = {
      findMemoryByText: vi.fn().mockReturnValue(null),
      getLatestConvTurnId: vi.fn().mockReturnValue(12),
      addMemory: vi.fn(),
    };

    const result = storeProjectMemoryCandidate(
      db as any,
      {
        type: "decision",
        scope: "project",
        text: "Bridge project memory writes stay inside BridgeDb.",
        confidence: 0.72,
      },
      {
        chatKey: "chat:1",
        cliKind: "codex",
        repoPath: "/repo",
      },
    );

    expect(result.status).toBe("stored");
    expect(db.findMemoryByText).toHaveBeenCalledWith("Bridge project memory writes stay inside BridgeDb.");
    expect(db.getLatestConvTurnId).toHaveBeenCalledWith("chat:1");
    expect(db.addMemory).toHaveBeenCalledWith(expect.objectContaining({
      type: "decision",
      scope: "project",
      text: "Bridge project memory writes stay inside BridgeDb.",
      source_chat_key: "chat:1",
      source_cli: "codex",
      source_turn_id: 12,
      source_repo_path: "/repo",
      confidence: 0.72,
    }));
  });
});

describe("post-turn memory extraction", () => {
  it("builds a bounded JSON-only extraction prompt from a turn", () => {
    const prompt = buildPostTurnMemoryExtractionPrompt({
      userPrompt: "Implement automatic durable memory extraction after each turn.",
      assistantText: "Done. Agent Bridge now stores durable memory candidates after successful turns.",
    });

    expect(prompt).toContain("Output ONLY a JSON array");
    expect(prompt).toContain("Implement automatic durable memory extraction");
    expect(prompt).toContain("Agent Bridge now stores durable memory candidates");
    expect(prompt).not.toContain("```");
  });

  it("parses JSON candidate arrays from extractor output", () => {
    const candidates = parsePostTurnMemoryCandidates([
      "```json",
      JSON.stringify([
        {
          type: "decision",
          scope: "project",
          text: "Agent Bridge post-turn extraction stores durable project memories automatically.",
          confidence: 0.84,
        },
      ]),
      "```",
    ].join("\n"));

    expect(candidates).toEqual([
      {
        type: "decision",
        scope: "project",
        text: "Agent Bridge post-turn extraction stores durable project memories automatically.",
        confidence: 0.84,
      },
    ]);
  });
});
