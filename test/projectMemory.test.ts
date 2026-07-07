import { describe, expect, it, vi } from "vitest";
import { extractProjectMemorySidecars, storeProjectMemoryCandidate } from "../src/projectMemory.js";

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
