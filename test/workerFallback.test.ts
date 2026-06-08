/**
 * Tests for WorkerFallbackChain — per-chat CLI fallback state + turn history.
 */

import { describe, it, expect } from "vitest";
import { WorkerFallbackChain, CONTEXT_TURNS } from "../src/workerFallback.js";

describe("WorkerFallbackChain", () => {
  describe("getActiveCli", () => {
    it("returns the first CLI in the chain by default", () => {
      const chain = new WorkerFallbackChain(["codex", "claude", "antigravity"]);
      expect(chain.getActiveCli("chat:1")).toBe("codex");
    });

    it("returns a different active CLI for different chat keys", () => {
      const chain = new WorkerFallbackChain(["codex", "claude"]);
      chain.advance("chat:1");
      expect(chain.getActiveCli("chat:1")).toBe("claude");
      expect(chain.getActiveCli("chat:2")).toBe("codex");
    });

    it("does not exceed chain bounds after multiple advances", () => {
      const chain = new WorkerFallbackChain(["codex", "claude"]);
      chain.advance("chat:1");
      chain.advance("chat:1"); // beyond end — should clamp to last
      expect(chain.getActiveCli("chat:1")).toBe("claude");
    });
  });

  describe("advance", () => {
    it("returns the next CLI in the chain", () => {
      const chain = new WorkerFallbackChain(["codex", "claude", "antigravity"]);
      expect(chain.advance("chat:1")).toBe("claude");
    });

    it("returns null when already at the last CLI", () => {
      const chain = new WorkerFallbackChain(["codex", "claude"]);
      chain.advance("chat:1"); // now at claude
      expect(chain.advance("chat:1")).toBeNull(); // exhausted
    });

    it("advancing one chat does not affect another", () => {
      const chain = new WorkerFallbackChain(["codex", "claude"]);
      chain.advance("chat:1");
      expect(chain.getActiveCli("chat:2")).toBe("codex");
    });
  });

  describe("isChainExhausted", () => {
    it("returns false when not at the last CLI", () => {
      const chain = new WorkerFallbackChain(["codex", "claude"]);
      expect(chain.isChainExhausted("chat:1")).toBe(false);
    });

    it("returns true when at the last CLI", () => {
      const chain = new WorkerFallbackChain(["codex", "claude"]);
      chain.advance("chat:1");
      expect(chain.isChainExhausted("chat:1")).toBe(true);
    });

    it("returns true for a single-item chain", () => {
      const chain = new WorkerFallbackChain(["codex"]);
      expect(chain.isChainExhausted("chat:1")).toBe(true);
    });
  });

  describe("resetToHead", () => {
    it("resets the active CLI back to the first in the chain", () => {
      const chain = new WorkerFallbackChain(["codex", "claude"]);
      chain.advance("chat:1");
      chain.resetToHead("chat:1");
      expect(chain.getActiveCli("chat:1")).toBe("codex");
    });
  });

  describe("addTurn + buildContextPreamble", () => {
    it("returns empty string when no turns have been added", () => {
      const chain = new WorkerFallbackChain(["codex", "claude"]);
      expect(chain.buildContextPreamble("chat:1")).toBe("");
    });

    it("includes user and assistant turns in the preamble", () => {
      const chain = new WorkerFallbackChain(["codex", "claude"]);
      chain.addTurn("chat:1", "user", "What is TypeScript?");
      chain.addTurn("chat:1", "assistant", "A typed superset of JavaScript.");
      const preamble = chain.buildContextPreamble("chat:1");
      expect(preamble).toContain("What is TypeScript?");
      expect(preamble).toContain("A typed superset of JavaScript.");
      expect(preamble).toContain("User:");
      expect(preamble).toContain("Assistant:");
    });

    it(`retains only the last ${CONTEXT_TURNS} full turns (user+assistant pairs)`, () => {
      const chain = new WorkerFallbackChain(["codex", "claude"]);
      // Add more than CONTEXT_TURNS pairs
      for (let i = 1; i <= CONTEXT_TURNS + 2; i++) {
        chain.addTurn("chat:1", "user", `question ${i}`);
        chain.addTurn("chat:1", "assistant", `answer ${i}`);
      }
      const preamble = chain.buildContextPreamble("chat:1");
      // The oldest turns should have been dropped
      expect(preamble).not.toContain("question 1");
      expect(preamble).not.toContain("answer 1");
      // The most recent turns should be present
      expect(preamble).toContain(`question ${CONTEXT_TURNS + 2}`);
    });

    it("preamble starts with a context header and ends with a separator", () => {
      const chain = new WorkerFallbackChain(["codex", "claude"]);
      chain.addTurn("chat:1", "user", "Hello");
      const preamble = chain.buildContextPreamble("chat:1");
      expect(preamble).toContain("[Context from previous conversation]");
      expect(preamble).toContain("[End context");
    });

    it("turns are isolated per chat key", () => {
      const chain = new WorkerFallbackChain(["codex", "claude"]);
      chain.addTurn("chat:1", "user", "message for chat 1");
      chain.addTurn("chat:2", "user", "message for chat 2");
      expect(chain.buildContextPreamble("chat:1")).toContain("message for chat 1");
      expect(chain.buildContextPreamble("chat:1")).not.toContain("message for chat 2");
    });
  });
});
