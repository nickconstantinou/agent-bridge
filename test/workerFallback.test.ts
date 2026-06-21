/**
 * Tests for WorkerFallbackChain — per-chat CLI fallback state + turn history.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { WorkerFallbackChain } from "../src/workerFallback.js";
import { DEFAULT_CONTEXT_MAX_CHARS } from "../src/db.js";
import { openDb, BridgeDb } from "../src/db.js";

describe("WorkerFallbackChain", () => {
  let db: BridgeDb;
  let chain: WorkerFallbackChain;

  beforeEach(() => {
    db = openDb(":memory:");
    chain = new WorkerFallbackChain(["codex", "claude", "antigravity"], db);
  });

  describe("getActiveCli", () => {
    it("returns the first CLI in the chain by default", () => {
      expect(chain.getActiveCli("chat:1")).toBe("codex");
    });

    it("returns a different active CLI for different chat keys", () => {
      chain.advance("chat:1");
      expect(chain.getActiveCli("chat:1")).toBe("claude");
      expect(chain.getActiveCli("chat:2")).toBe("codex");
    });

    it("does not exceed chain bounds after multiple advances", () => {
      const c = new WorkerFallbackChain(["codex", "claude"], db);
      c.advance("chat:1");
      c.advance("chat:1"); // beyond end — should clamp to last
      expect(c.getActiveCli("chat:1")).toBe("claude");
    });
  });

  describe("advance", () => {
    it("returns the next CLI in the chain", () => {
      expect(chain.advance("chat:1")).toBe("claude");
    });

    it("returns null when already at the last CLI", () => {
      const c = new WorkerFallbackChain(["codex", "claude"], db);
      c.advance("chat:1"); // now at claude
      expect(c.advance("chat:1")).toBeNull(); // exhausted
    });

    it("advancing one chat does not affect another", () => {
      chain.advance("chat:1");
      expect(chain.getActiveCli("chat:2")).toBe("codex");
    });
  });

  describe("getChain", () => {
    it("returns a copy of the fallback chain array", () => {
      const chainList = ["codex", "claude", "antigravity"];
      const c = new WorkerFallbackChain(chainList, db);
      expect(c.getChain()).toEqual(chainList);
      expect(c.getChain()).not.toBe(chainList);
    });
  });

  describe("isChainExhausted", () => {
    it("returns false when not at the last CLI", () => {
      const c = new WorkerFallbackChain(["codex", "claude"], db);
      expect(c.isChainExhausted("chat:1")).toBe(false);
    });

    it("returns true when at the last CLI", () => {
      const c = new WorkerFallbackChain(["codex", "claude"], db);
      c.advance("chat:1");
      expect(c.isChainExhausted("chat:1")).toBe(true);
    });

    it("returns true for a single-item chain", () => {
      const c = new WorkerFallbackChain(["codex"], db);
      expect(c.isChainExhausted("chat:1")).toBe(true);
    });
  });

  describe("resetToHead", () => {
    it("resets the active CLI back to the first in the chain", () => {
      const c = new WorkerFallbackChain(["codex", "claude"], db);
      c.advance("chat:1");
      c.resetToHead("chat:1");
      expect(c.getActiveCli("chat:1")).toBe("codex");
    });
  });

  describe("addTurn + buildContextPreamble", () => {
    it("returns empty string when no turns have been added", () => {
      expect(chain.buildContextPreamble("chat:1")).toBe("");
    });

    it("includes user and assistant turns in the preamble", () => {
      chain.addTurn("chat:1", "user", "What is TypeScript?");
      chain.addTurn("chat:1", "assistant", "A typed superset of JavaScript.");
      const preamble = chain.buildContextPreamble("chat:1");
      expect(preamble).toContain("What is TypeScript?");
      expect(preamble).toContain("A typed superset of JavaScript.");
      expect(preamble).toContain("User:");
      expect(preamble).toContain("Assistant:");
    });

    it("drops oldest turns when char budget is exceeded", () => {
      // bigText chosen so that "User: <newest>" + "User: <bigText>" nearly fills the
      // budget, leaving < 17 chars — not enough room for "User: oldest turn" (17 chars).
      // Formula: budget(8000) - 17(newest line) - 6(prefix) - bigTextLen < 17
      //          → bigTextLen > 7960; use 7970 for a clean margin.
      const bigText = "x".repeat(DEFAULT_CONTEXT_MAX_CHARS - 30); // 7970 chars
      chain.addTurn("chat:1", "user", "oldest turn");
      chain.addTurn("chat:1", "user", bigText);
      chain.addTurn("chat:1", "user", "newest turn");
      const preamble = chain.buildContextPreamble("chat:1");
      expect(preamble).toContain("newest turn");
      expect(preamble).not.toContain("oldest turn");
    });

    it("preamble starts with a context header and ends with a separator", () => {
      chain.addTurn("chat:1", "user", "Hello");
      const preamble = chain.buildContextPreamble("chat:1");
      expect(preamble).toContain("[Context from previous conversation]");
      expect(preamble).toContain("[End context");
    });

    it("turns are isolated per chat key", () => {
      chain.addTurn("chat:1", "user", "message for chat 1");
      chain.addTurn("chat:2", "user", "message for chat 2");
      expect(chain.buildContextPreamble("chat:1")).toContain("message for chat 1");
      expect(chain.buildContextPreamble("chat:1")).not.toContain("message for chat 2");
    });
  });

  describe("addTurn + buildContextPreamble (persistent)", () => {
    it("returns empty string when no turns", () => {
      expect(chain.buildContextPreamble("chat:1")).toBe("");
    });

    it("includes stored turns in preamble", () => {
      chain.addTurn("chat:1", "user", "hello");
      chain.addTurn("chat:1", "assistant", "hi there");
      const preamble = chain.buildContextPreamble("chat:1");
      expect(preamble).toContain("User: hello");
      expect(preamble).toContain("Assistant: hi there");
    });

    it("turns survive across WorkerFallbackChain instances (persistence)", () => {
      chain.addTurn("chat:1", "user", "remembered");
      const chain2 = new WorkerFallbackChain(["codex", "claude"], db);
      expect(chain2.buildContextPreamble("chat:1")).toContain("remembered");
    });
  });
});
