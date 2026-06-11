import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import type { TelegramMessage } from "../src/types.js";
import { type as eventType } from "../src/events/types.js";

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

    it("uses executionKind for non-agent CLI invocation and parsing", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const runCli = vi.fn().mockResolvedValue("***\nUse the Agy-specific response.");
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          kind: "health",
          executionKind: "antigravity",
          botConfig: { command: "agy", modelPreference: ["gemini-3-pro-preview"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          hooks: {
            onBeforeExecute: async (prompt) => `HEALTH CONTEXT\n\n${prompt}`,
          },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("diagnose health report")]);

      expect(runCli).toHaveBeenCalledOnce();
      const [command, args] = runCli.mock.calls[0];
      expect(command).toBe("agy");
      expect(args).toContain("--print");
      expect(args).not.toContain("--output-format");
      expect(client.sendMessage).toHaveBeenCalledOnce();
      expect(client.sendMessage.mock.calls[0][0].text).toBe("Use the Agy-specific response.");
    });

    it("retries Agy print timeouts once with a fresh conversation and recent context", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const capturedPrompts: string[] = [];
      const capturedArgs: string[][] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(args);
        capturedPrompts.push(args[args.length - 1]);
        if (runCli.mock.calls.length === 1) return "***\nPrior answer from Agy";
        if (runCli.mock.calls.length === 2) return "Error: timed out waiting for response";
        return "***\nRecovered answer";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      db.setSession("100", "antigravity", "stale-conversation");

      await engine.handleMessages([makeMessage("first question")]);
      await engine.handleMessages([makeMessage("second question")]);

      expect(runCli).toHaveBeenCalledTimes(3);
      expect(db.getSession("100", "antigravity")).not.toBe("stale-conversation");
      expect(capturedArgs[2]).not.toContain("--conversation");
      expect(capturedPrompts[2]).toContain("[Context from previous conversation]");
      expect(capturedPrompts[2]).toContain("User: first question");
      expect(capturedPrompts[2]).toContain("Assistant: Prior answer from Agy");
      expect(capturedPrompts[2]).toContain("User request:");
      expect(capturedPrompts[2]).toContain("second question");
      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).toBe("Recovered answer");
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

  describe("BridgeEvent persistence", () => {
    it("persists one run and lifecycle events from the async production path", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const rawOutput = [
        JSON.stringify({ type: "thread.started", thread_id: "session-123" }),
        JSON.stringify({ type: "response.completed", output_text: "Persisted final answer" }),
      ].join("\n");

      const runCliAsync = vi.fn().mockImplementation(async (
        _command: string,
        _args: string[],
        cwd: string,
        options: any,
      ) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "codex", cwd, model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: rawOutput, source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });

      const engine = new BridgeEngine(
        {
          kind: "codex",
          botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: true,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      await engine.handleMessages([makeMessage("persist this run")]);

      const runs = db.raw.prepare("SELECT * FROM bridge_runs").all() as any[];
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        chat_id: "100",
        bot: "codex",
        status: "done",
        session_id: "session-123",
        final_text_preview: "Persisted final answer",
      });

      const events = db.getEventsForRun(runs[0].run_id);
      expect(events.map((event) => event.type)).toEqual(["run.started", "run.completed"]);
      expect(events.map((event) => JSON.parse(event.payload_json).type)).toEqual(["run.started", "run.completed"]);
    });
  });

  describe("onCapacityExhausted hook", () => {
    it("calls onCapacityExhausted when CLI throws a capacity error", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const runCli = vi.fn().mockRejectedValue(new Error("MODEL_CAPACITY_EXHAUSTED"));
      const client = makeMockClient();
      const exhaustedChats: string[] = [];

      const engine = new BridgeEngine(
        {
          kind: "codex",
          botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          hooks: {
            onCapacityExhausted: async (chatKey) => { exhaustedChats.push(chatKey); },
          },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(exhaustedChats).toHaveLength(1);
      expect(exhaustedChats[0]).toBe("100");
    });

    it("does not call onCapacityExhausted for non-capacity errors", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const runCli = vi.fn().mockRejectedValue(new Error("some other error"));
      const client = makeMockClient();
      const exhaustedCalled = vi.fn();

      const engine = new BridgeEngine(
        {
          kind: "codex",
          botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          hooks: {
            onCapacityExhausted: exhaustedCalled,
          },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(exhaustedCalled).not.toHaveBeenCalled();
    });
    it("clears session ID, remembers recent turns, and retries with context on invalid session error", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const runCli = vi.fn()
        .mockResolvedValueOnce("Hello there! I am Claude.")
        .mockRejectedValueOnce(new Error("CLI exited with code 1: No conversation found with session ID: invalid-session-id-123"))
        .mockResolvedValueOnce("Successful fresh retry result");

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
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      db.setSession("100", "claude", "invalid-session-id-123");

      await engine.handleMessages([makeMessage("help me")]);

      expect(db.getSession("100", "claude")).toBeNull();
      expect(runCli).toHaveBeenCalledTimes(3);
      expect(client.sendMessage).toHaveBeenCalledTimes(2);
      expect(client.sendMessage.mock.calls[1][0].text).toContain("Successful fresh retry result");

      const thirdCallArgs = runCli.mock.calls[2][1];
      const promptArg = thirdCallArgs[thirdCallArgs.length - 1];
      expect(promptArg).toContain("[Context from previous conversation]");
      expect(promptArg).toContain("User: hello");
      expect(promptArg).toContain("Assistant: Hello there! I am Claude.");
      expect(promptArg).toContain("help me");
    });
  });
});
