/**
 * Tests for worker bot dispatch-with-fallback orchestration.
 * Validates that plain messages route to the active CLI engine and that
 * capacity exhaustion advances the fallback chain and retries.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkerFallbackChain } from "../src/workerFallback.js";
import { dispatchWithFallback } from "../src/workerDispatch.js";

// ── Minimal engine stub ───────────────────────────────────────────────────────

interface MockEngine {
  kind: string;
  handleCount: number;
  handleUpdate: (update: any) => Promise<void>;
}

function makeMockEngine(kind: string): MockEngine {
  return {
    kind,
    handleCount: 0,
    async handleUpdate(_update: any) { this.handleCount++; },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("dispatchWithFallback", () => {
  let codex: MockEngine;
  let claude: MockEngine;
  let antigravity: MockEngine;
  let fallbackChain: WorkerFallbackChain;
  let exhaustedChats: Set<string>;
  let contextPreambles: Map<string, string>;
  let sentMessages: string[];

  beforeEach(() => {
    codex = makeMockEngine("codex");
    claude = makeMockEngine("claude");
    antigravity = makeMockEngine("antigravity");
    fallbackChain = new WorkerFallbackChain(["codex", "claude", "antigravity"]);
    exhaustedChats = new Set();
    contextPreambles = new Map();
    sentMessages = [];
  });

  const deps = () => ({
    engines: { codex, claude, antigravity },
    fallbackChain,
    exhaustedChats,
    contextPreambles,
    notify: (msg: string) => { sentMessages.push(msg); },
  });

  it("routes to the active CLI (codex by default)", async () => {
    await dispatchWithFallback({ message: "hello" }, "chat:1", deps());
    expect(codex.handleCount).toBe(1);
    expect(claude.handleCount).toBe(0);
    expect(antigravity.handleCount).toBe(0);
  });

  it("routes to a non-default active CLI after the chain is advanced", async () => {
    fallbackChain.advance("chat:1"); // advance to claude
    await dispatchWithFallback({ message: "hello" }, "chat:1", deps());
    expect(codex.handleCount).toBe(0);
    expect(claude.handleCount).toBe(1);
  });

  it("falls back to the next CLI when capacity is exhausted", async () => {
    codex.handleUpdate = async () => {
      codex.handleCount++;
      exhaustedChats.add("chat:1");
    };

    await dispatchWithFallback({ message: "hello" }, "chat:1", deps());

    expect(codex.handleCount).toBe(1);
    expect(claude.handleCount).toBe(1);
    expect(fallbackChain.getActiveCli("chat:1")).toBe("claude");
  });

  it("sends a switch notification when falling back", async () => {
    codex.handleUpdate = async () => {
      codex.handleCount++;
      exhaustedChats.add("chat:1");
    };

    await dispatchWithFallback({ message: "hello" }, "chat:1", deps());
    expect(sentMessages.some(m => m.toLowerCase().includes("claude"))).toBe(true);
  });

  it("sets context preamble before the fallback engine handles the update", async () => {
    fallbackChain.addTurn("chat:1", "user", "prior user message");
    fallbackChain.addTurn("chat:1", "assistant", "prior assistant response");
    codex.handleUpdate = async () => {
      codex.handleCount++;
      exhaustedChats.add("chat:1");
    };

    const capturedPreambles: string[] = [];
    claude.handleUpdate = async () => {
      claude.handleCount++;
      if (contextPreambles.has("chat:1")) {
        capturedPreambles.push(contextPreambles.get("chat:1")!);
      }
    };

    await dispatchWithFallback({ message: "new question" }, "chat:1", deps());
    expect(capturedPreambles.length).toBeGreaterThanOrEqual(1);
    expect(capturedPreambles[0]).toContain("prior user message");
  });

  it("reports all-exhausted when the entire chain is at capacity", async () => {
    for (const eng of [codex, claude, antigravity]) {
      const e = eng;
      e.handleUpdate = async () => {
        e.handleCount++;
        exhaustedChats.add("chat:1");
      };
    }

    await dispatchWithFallback({ message: "hello" }, "chat:1", deps());
    expect(sentMessages.some(m => m.toLowerCase().includes("exhausted") || m.toLowerCase().includes("unavailable"))).toBe(true);
  });
});
