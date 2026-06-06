/**
 * Phase 1 — BridgeEvent types and RunView reducer.
 * Written before any implementation (red state).
 */

import { describe, it, expect } from "vitest";

// ── Type contract ─────────────────────────────────────────────────────────────

describe("BridgeEvent type contract", () => {
  it("RunStartedEvent has required fields", async () => {
    const { type } = await import("../src/events/types.js");
    const event: ReturnType<typeof type.runStarted> = type.runStarted({
      runId: "r-1",
      bot: "claude",
      chatId: "100",
      command: "claude",
      cwd: "/home/user",
      model: "claude-sonnet-4-6",
    });
    expect(event.type).toBe("run.started");
    expect(event.version).toBe(1);
    expect(event.runId).toBe("r-1");
    expect(event.bot).toBe("claude");
    expect(event.chatId).toBe("100");
    expect(event.command).toBe("claude");
    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeDefined();
  });

  it("TextDeltaEvent carries text and source", async () => {
    const { type } = await import("../src/events/types.js");
    const event = type.textDelta({ runId: "r-1", bot: "claude", chatId: "100", text: "hello", source: "stdout" });
    expect(event.type).toBe("text.delta");
    expect(event.text).toBe("hello");
    expect(event.source).toBe("stdout");
  });

  it("RunCompletedEvent carries final text and sessionId", async () => {
    const { type } = await import("../src/events/types.js");
    const event = type.runCompleted({ runId: "r-1", bot: "claude", chatId: "100", text: "done", sessionId: "s-1" });
    expect(event.type).toBe("run.completed");
    expect(event.text).toBe("done");
    expect(event.sessionId).toBe("s-1");
  });

  it("RunFailedEvent carries error string and category", async () => {
    const { type } = await import("../src/events/types.js");
    const event = type.runFailed({ runId: "r-1", bot: "claude", chatId: "100", error: "timeout", category: "timeout" });
    expect(event.type).toBe("run.failed");
    expect(event.error).toBe("timeout");
    expect(event.category).toBe("timeout");
  });

  it("RunCancelledEvent carries reason", async () => {
    const { type } = await import("../src/events/types.js");
    const event = type.runCancelled({ runId: "r-1", bot: "claude", chatId: "100", reason: "user" });
    expect(event.type).toBe("run.cancelled");
    expect(event.reason).toBe("user");
  });

  it("each event gets a unique id", async () => {
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "claude" as const, chatId: "100" };
    const a = type.textDelta({ ...base, text: "a", source: "stdout" as const });
    const b = type.textDelta({ ...base, text: "b", source: "stdout" as const });
    expect(a.id).not.toBe(b.id);
  });
});

// ── RunView reducer ───────────────────────────────────────────────────────────

describe("RunView reducer", () => {
  it("starts in idle state with empty events", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const view = reduce([]);
    expect(view.status).toBe("idle");
    expect(view.text).toBe("");
  });

  it("run.started sets status to running", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const view = reduce([
      type.runStarted({ runId: "r-1", bot: "claude", chatId: "100", command: "claude", cwd: "/", model: null }),
    ]);
    expect(view.status).toBe("running");
    expect(view.runId).toBe("r-1");
  });

  it("text.delta events are appended in order", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "claude" as const, chatId: "100" };
    const view = reduce([
      type.runStarted({ ...base, command: "claude", cwd: "/", model: null }),
      type.textDelta({ ...base, text: "Hello ", source: "stdout" }),
      type.textDelta({ ...base, text: "world", source: "stdout" }),
    ]);
    expect(view.text).toBe("Hello world");
    expect(view.status).toBe("running");
  });

  it("run.completed sets final text, sessionId, and status done", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "claude" as const, chatId: "100" };
    const view = reduce([
      type.runStarted({ ...base, command: "claude", cwd: "/", model: null }),
      type.textDelta({ ...base, text: "interim ", source: "stdout" }),
      type.runCompleted({ ...base, text: "Final answer", sessionId: "s-99" }),
    ]);
    expect(view.status).toBe("done");
    expect(view.text).toBe("Final answer");
    expect(view.sessionId).toBe("s-99");
  });

  it("run.completed overrides accumulated delta text with authoritative final text", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "codex" as const, chatId: "100" };
    const view = reduce([
      type.runStarted({ ...base, command: "codex", cwd: "/", model: null }),
      type.textDelta({ ...base, text: "partial delta", source: "stdout" }),
      type.runCompleted({ ...base, text: "Authoritative final", sessionId: null }),
    ]);
    expect(view.text).toBe("Authoritative final");
  });

  it("run.failed stores error and sets status failed", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "claude" as const, chatId: "100" };
    const view = reduce([
      type.runStarted({ ...base, command: "claude", cwd: "/", model: null }),
      type.runFailed({ ...base, error: "CLI hard timeout after 1800000ms", category: "timeout" }),
    ]);
    expect(view.status).toBe("failed");
    expect(view.error).toContain("timeout");
  });

  it("run.cancelled sets status cancelled", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "claude" as const, chatId: "100" };
    const view = reduce([
      type.runStarted({ ...base, command: "claude", cwd: "/", model: null }),
      type.runCancelled({ ...base, reason: "user" }),
    ]);
    expect(view.status).toBe("cancelled");
  });

  it("updatedAt advances with each event", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "claude" as const, chatId: "100" };
    const v1 = reduce([type.runStarted({ ...base, command: "claude", cwd: "/", model: null })]);
    // Small delay to ensure timestamps differ
    await new Promise(r => setTimeout(r, 5));
    const v2 = reduce([
      type.runStarted({ ...base, command: "claude", cwd: "/", model: null }),
      type.runCompleted({ ...base, text: "done", sessionId: null }),
    ]);
    expect(new Date(v2.updatedAt) >= new Date(v1.updatedAt)).toBe(true);
  });
});
