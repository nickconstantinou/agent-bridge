import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import type { TelegramMessage } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessage(text: string, userId = 42, chatId = 100): TelegramMessage {
  return {
    message_id: Math.floor(Math.random() * 10000),
    chat: { id: chatId, type: "private" },
    from: { id: userId, first_name: "Test" },
    text,
  };
}

function makeMockClient() {
  return {
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("BridgeEngine", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `engine-test-${Date.now()}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  describe("onCommand hook", () => {
    it("calls onCommand and uses its text result without invoking the CLI", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn().mockResolvedValue("should not be called");
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          kind: "health",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          hooks: {
            onCommand: async (cmd) => cmd === "/health" ? { text: "All systems green." } : null,
          },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/health")]);

      expect(runCli).not.toHaveBeenCalled();
      expect(client.sendMessage).toHaveBeenCalledOnce();
      const sentBody = client.sendMessage.mock.calls[0][0];
      expect(sentBody.text).toContain("All systems green.");
    });

    it("falls through to built-in /start handler when onCommand returns null", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn();
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          hooks: {
            onCommand: async () => null, // always pass through
          },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/start")]);

      expect(runCli).not.toHaveBeenCalled();
      expect(client.sendMessage).toHaveBeenCalledOnce();
      const sentBody = client.sendMessage.mock.calls[0][0];
      expect(sentBody.text).toContain("bridge ready");
    });

    it("handles /start with no hook configured (built-in path)", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn();
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          kind: "codex",
          botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/start")]);

      expect(runCli).not.toHaveBeenCalled();
      expect(client.sendMessage).toHaveBeenCalledOnce();
      const sentBody = client.sendMessage.mock.calls[0][0];
      expect(sentBody.text).toContain("bridge ready");
    });
  });

  describe("onBeforeExecute hook", () => {
    it("calls onBeforeExecute and passes the transformed prompt to CLI", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      let capturedPrompt: string | null = null;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[args.length - 1];
        return "response";
      });

      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          hooks: {
            onBeforeExecute: async (prompt) => `CONTEXT: health ok\n\n${prompt}`,
          },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("what is the disk usage?")]);

      expect(runCli).toHaveBeenCalledOnce();
      expect(capturedPrompt).toContain("CONTEXT: health ok");
      expect(capturedPrompt).toContain("what is the disk usage?");
    });

    it("does not call onBeforeExecute for commands (only for free-form prompts)", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const beforeExecute = vi.fn().mockImplementation(async (p: string) => p);
      const runCli = vi.fn();
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          hooks: { onBeforeExecute: beforeExecute },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/start")]);

      expect(beforeExecute).not.toHaveBeenCalled();
      expect(runCli).not.toHaveBeenCalled();
    });
  });

  describe("authorization", () => {
    it("ignores messages from unauthorized user IDs", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn();
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["99999"]), // only 99999 allowed
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello", 42)]); // from user 42, not allowed

      expect(runCli).not.toHaveBeenCalled();
      expect(client.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("/stop handling", () => {
    it("sends abort confirmation and does not queue when /stop received", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      await engine.handleUpdate({
        update_id: 1,
        message: makeMessage("/stop"),
      });

      expect(client.sendMessage).toHaveBeenCalledOnce();
      const sentBody = client.sendMessage.mock.calls[0][0];
      expect(sentBody.text).toContain("aborted");
    });
  });

  describe("concurrency lock", () => {
    it("queues a second message when first is still holding the lock", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      // Hold the lock externally to simulate an in-flight execution
      db.tryLock("100");

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      await engine.handleMessages([makeMessage("queued message")]);

      expect(client.sendMessage).toHaveBeenCalledOnce();
      const sentBody = client.sendMessage.mock.calls[0][0];
      expect(sentBody.text).toContain("Queued");
    });
  });
});
