/**
 * Phase 0 characterisation tests.
 * These lock existing observable behaviour before the event-normalisation
 * refactor begins. All tests here must be GREEN on first run — if any fail,
 * that is a bug to fix before proceeding with the events plan.
 */

import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";

// ── parseCliResult — Codex output shapes ─────────────────────────────────────

describe("parseCliResult — Codex JSON output", () => {
  it("extracts session ID from thread.started event", async () => {
    const { parseCliResult } = await import("../src/cli.js");
    const stdout = JSON.stringify({ type: "thread.started", thread_id: "abc-123" });
    const result = parseCliResult({ bot: "codex", stdout });
    expect(result.sessionId).toBe("abc-123");
  });

  it("extracts final text from item.completed agent_message", async () => {
    const { parseCliResult } = await import("../src/cli.js");
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Hello from Codex" } }),
    ].join("\n");
    const result = parseCliResult({ bot: "codex", stdout: lines });
    expect(result.text).toBe("Hello from Codex");
  });

  it("extracts final text from response.completed output_text", async () => {
    const { parseCliResult } = await import("../src/cli.js");
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "t-2" }),
      JSON.stringify({ type: "response.completed", output_text: "Completed response" }),
    ].join("\n");
    const result = parseCliResult({ bot: "codex", stdout: lines });
    expect(result.text).toBe("Completed response");
  });

  it("accumulates delta chunks when no final text event is present", async () => {
    const { parseCliResult } = await import("../src/cli.js");
    const lines = [
      JSON.stringify({ type: "response.output_text.delta", delta: "Hello " }),
      JSON.stringify({ type: "response.output_text.delta", delta: "world" }),
    ].join("\n");
    const result = parseCliResult({ bot: "codex", stdout: lines });
    expect(result.text).toBe("Hello world");
  });

  it("prefers item.completed final text over accumulated deltas", async () => {
    const { parseCliResult } = await import("../src/cli.js");
    const lines = [
      JSON.stringify({ type: "response.output_text.delta", delta: "partial " }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final answer" } }),
    ].join("\n");
    const result = parseCliResult({ bot: "codex", stdout: lines });
    expect(result.text).toBe("Final answer");
  });

  it("returns empty text and null sessionId for empty stdout", async () => {
    const { parseCliResult } = await import("../src/cli.js");
    const result = parseCliResult({ bot: "codex", stdout: "" });
    expect(result.text).toBe("");
    expect(result.sessionId).toBeNull();
  });
});

// ── parseCliResult — Claude output shapes ────────────────────────────────────

describe("parseCliResult — Claude JSON output", () => {
  it("extracts text and session_id from JSON result line", async () => {
    const { parseCliResult } = await import("../src/cli.js");
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "This is the answer",
      session_id: "sess-abc",
    });
    const result = parseCliResult({ bot: "claude", stdout });
    expect(result.text).toBe("This is the answer");
    expect(result.sessionId).toBe("sess-abc");
  });

  it("falls back to raw stdout when no JSON result line is present", async () => {
    const { parseCliResult } = await import("../src/cli.js");
    const result = parseCliResult({ bot: "claude", stdout: "Plain text response" });
    expect(result.text).toBe("Plain text response");
    expect(result.sessionId).toBeNull();
  });

  it("picks the last JSON result line when multiple JSON lines are present", async () => {
    const { parseCliResult } = await import("../src/cli.js");
    const stdout = [
      JSON.stringify({ type: "assistant", content: "interim" }),
      JSON.stringify({ type: "result", result: "Final answer", session_id: "s-1" }),
    ].join("\n");
    const result = parseCliResult({ bot: "claude", stdout });
    expect(result.text).toBe("Final answer");
  });

  it("trims whitespace from extracted result text", async () => {
    const { parseCliResult } = await import("../src/cli.js");
    const stdout = JSON.stringify({ result: "  answer with spaces  ", session_id: null });
    const result = parseCliResult({ bot: "claude", stdout });
    expect(result.text).toBe("answer with spaces");
  });
});

// ── splitTelegramText — chunk splitting ──────────────────────────────────────

describe("splitTelegramText", () => {
  it("returns text as single chunk when within limit", async () => {
    const { splitTelegramText } = await import("../src/render.js");
    const text = "Short message";
    const chunks = splitTelegramText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("splits text over the limit into multiple chunks", async () => {
    const { splitTelegramText } = await import("../src/render.js");
    const text = "a".repeat(4000);
    const chunks = splitTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3500);
    }
  });

  it("reassembled chunks contain all original content", async () => {
    const { splitTelegramText } = await import("../src/render.js");
    const text = ("word ".repeat(700)).trimEnd();
    const chunks = splitTelegramText(text);
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("prefers splitting at paragraph boundaries over mid-word", async () => {
    const { splitTelegramText } = await import("../src/render.js");
    const para = "Line of text.\n\n";
    const text = para.repeat(200);
    const chunks = splitTelegramText(text);
    for (const chunk of chunks) {
      // chunks should not end mid-word — they should end at boundaries
      expect(chunk.trim()).not.toMatch(/\w-$/);
    }
  });

  it("handles empty string without throwing", async () => {
    const { splitTelegramText } = await import("../src/render.js");
    expect(splitTelegramText("")).toEqual([""]);
  });
});

// ── /reset command — session clearing ────────────────────────────────────────

describe("BridgeEngine /reset command", () => {
  it("sends session-reset confirmation message", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    const dbPath = join(tmpdir(), `char-test-reset-${Date.now()}.sqlite`);
    const db = openDb(dbPath);
    const sent: string[] = [];
    const client = {
      getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
      sendMessage: vi.fn().mockImplementation(async (body: any) => {
        sent.push(body.text ?? "");
        return { ok: true, result: { message_id: 1 } };
      }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
      setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
      answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
      sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
      sendDocument: vi.fn().mockResolvedValue({ ok: true }),
    } as any;

    const engine = new BridgeEngine(
      {
        surfaceIdentity: "test",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        asyncEnabled: false,
        pollIntervalMs: 1000,
      },
      db,
      client,
    );

    await engine.handleMessages([{
      message_id: 1,
      chat: { id: 100, type: "private" },
      from: { id: 42, first_name: "Test" },
      text: "/reset",
    }]);

    db.close();
    try { rmSync(dbPath); } catch {}

    expect(sent).toHaveLength(1);
    expect(sent[0].toLowerCase()).toContain("reset");
  });

  it("unlocks the chat so the next message is not queued indefinitely", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    const dbPath = join(tmpdir(), `char-test-reset-lock-${Date.now()}.sqlite`);
    const db = openDb(dbPath);

    // Simulate a held lock — tryLock returns true on first call (acquired), false when already held
    const acquired = db.tryLock("test", "100");
    expect(acquired).toBe(true);
    expect(db.tryLock("test", "100")).toBe(false); // still locked

    const client = {
      getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
      setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
      answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
      sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
      sendDocument: vi.fn().mockResolvedValue({ ok: true }),
    } as any;

    const engine = new BridgeEngine(
      {
        surfaceIdentity: "test",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        asyncEnabled: false,
        pollIntervalMs: 1000,
      },
      db,
      client,
    );

    await engine.handleMessages([{
      message_id: 2,
      chat: { id: 100, type: "private" },
      from: { id: 42, first_name: "Test" },
      text: "/reset",
    }]);

    // After /reset, tryLock should succeed again (lock was released)
    expect(db.tryLock("test", "100")).toBe(true);

    db.close();
    try { rmSync(dbPath); } catch {}
  });
});
