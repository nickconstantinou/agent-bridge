import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import type { BridgeConfig, TelegramMessage } from "../src/types.js";
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

function makeFullConfig(dbPath: string): BridgeConfig {
  return {
    allowedUserIds: new Set(["42"]),
    serviceEnvFile: null,
    serviceKind: null,
    pollIntervalMs: 1000,
    executionMode: "safe",
    asyncEnabled: false,
    dbPath,
    bots: {
      codex: { token: undefined, command: "codex", modelPreference: [] },
      claude: { token: undefined, command: "claude", modelPreference: [] },
      antigravity: { token: undefined, command: "agy", modelPreference: [] },
    },
  };
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

    it("retries recoverable Agy cascade errors once with a fresh conversation and recent context", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const capturedPrompts: string[] = [];
      const capturedArgs: string[][] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(args);
        capturedPrompts.push(args[args.length - 1]);
        if (runCli.mock.calls.length === 1) return "***\nPrior answer from Agy";
        if (runCli.mock.calls.length === 2) {
          throw new Error('{"type":"error","message":"error executing cascade step: CORTEX_STEP_TYPE_GREP_SEARCH: grep: -r: No such file or directory: exit status 2"}');
        }
        return "***\nRecovered after reset";
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
      expect(capturedArgs[2]).not.toContain("--conversation");
      expect(capturedPrompts[2]).toContain("[Context from previous conversation]");
      expect(capturedPrompts[2]).toContain("User: first question");
      expect(capturedPrompts[2]).toContain("Assistant: Prior answer from Agy");
      expect(capturedPrompts[2]).toContain("second question");
      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).toBe("Recovered after reset");
    });

    it("retries stalled Agy planner loops once with a fresh conversation and recent context", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const capturedPrompts: string[] = [];
      const capturedArgs: string[][] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(args);
        capturedPrompts.push(args[args.length - 1]);
        if (runCli.mock.calls.length === 1) return "***\nPrior answer from Agy";
        if (runCli.mock.calls.length === 2) {
          throw new Error("Agy stalled in planner loop without usable output");
        }
        return "***\nRecovered from stall";
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
      expect(capturedArgs[2]).not.toContain("--conversation");
      expect(capturedPrompts[2]).toContain("[Context from previous conversation]");
      expect(capturedPrompts[2]).toContain("User: first question");
      expect(capturedPrompts[2]).toContain("Assistant: Prior answer from Agy");
      expect(capturedPrompts[2]).toContain("second question");
      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).toBe("Recovered from stall");
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

    it("pending queue survives engine re-instantiation", () => {
      // This test verifies the queue is now backed by SQLite, not an in-memory Map.
      // After a new engine instance is created with the same db, the queued message
      // should be visible.
      db.tryLock("chat:1");
      db.enqueueMsg("chat:1", { prompt: "hello", chatId: 1, chatType: "private" });
      // Simulate engine restart: new instance, same db
      expect(db.pendingMsgCount("chat:1")).toBe(1);
      const msgs = db.dequeueMsgs("chat:1");
      expect(msgs[0].prompt).toBe("hello");
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
    it("falls back to the next model in preference list and retries with context and null sessionId on capacity error", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const runCli = vi.fn()
        .mockResolvedValueOnce("Hello there! I am Claude Sonnet.")
        .mockRejectedValueOnce(new Error("CLI exited with code 1: You've hit your session limit · resets 1pm (Europe/London)"))
        .mockResolvedValueOnce("Successful fallback model retry result");

      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: {
            command: "claude",
            modelPreference: ["claude-sonnet-4-6", "claude-opus-4-7"]
          },
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

      db.setSession("100", "claude", "session-sonnet-123");

      await engine.handleMessages([makeMessage("do something")]);

      expect(runCli).toHaveBeenCalledTimes(3);

      const thirdCallArgs = runCli.mock.calls[2][1];
      const modelIdx = thirdCallArgs.indexOf("--model");
      expect(modelIdx).not.toBe(-1);
      expect(thirdCallArgs[modelIdx + 1]).toBe("claude-opus-4-7");
      expect(thirdCallArgs.indexOf("--resume")).toBe(-1);

      const promptArg = thirdCallArgs[thirdCallArgs.length - 1];
      expect(promptArg).toContain("[Context from previous conversation]");
      expect(promptArg).toContain("User: hello");
      expect(promptArg).toContain("Assistant: Hello there! I am Claude Sonnet.");
      expect(promptArg).toContain("do something");
    });
  });

  // ── Topic-aware /stop and session storage ───────────────────────────────────

  function makeGroupMessage(text: string, userId = 42, chatId = 100, threadId = 7): TelegramMessage {
    return {
      message_id: Math.floor(Math.random() * 10000),
      chat: { id: chatId, type: "supergroup" },
      from: { id: userId, first_name: "Test" },
      message_thread_id: threadId,
      text,
    };
  }

  describe("/stop in a supergroup thread", () => {
    it("clears the pending queue for the thread-aware key so the next queued message gets position 1", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      // chatId=100, threadId=7 → topic-aware key is "100:7"
      const threadKey = "100:7";
      db.tryLock(threadKey); // hold lock to force queueing

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

      // Queue first message → position 1
      await engine.handleMessages([makeGroupMessage("first message")]);
      const firstQ = client.sendMessage.mock.calls.find((c: any[]) => c[0]?.text?.includes("position 1"));
      expect(firstQ).toBeDefined();

      client.sendMessage.mockClear();

      // /stop should clear the topic-aware queue
      await engine.handleUpdate({ update_id: 2, message: makeGroupMessage("/stop") });

      client.sendMessage.mockClear();

      // Next queued message must show position 1 again — not 2 — proving queue was cleared
      await engine.handleMessages([makeGroupMessage("second message")]);
      const secondQ = client.sendMessage.mock.calls.find((c: any[]) => c[0]?.text?.includes("Queued"));
      expect(secondQ).toBeDefined();
      expect(secondQ![0].text).toContain("position 1");
    });

    it("sends the abort confirmation into the correct thread", async () => {
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

      await engine.handleUpdate({ update_id: 1, message: makeGroupMessage("/stop") });

      expect(client.sendMessage).toHaveBeenCalledOnce();
      const body = client.sendMessage.mock.calls[0][0];
      expect(body.text).toContain("aborted");
      expect(body.message_thread_id).toBe(7);
    });
  });

  // ── Thread vs non-thread parity ──────────────────────────────────────────────

  describe("thread vs non-thread parity", () => {
    it("stores session under flat chatId for private chat messages", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      const rawOutput = JSON.stringify({ result: "done", session_id: "private-session-xyz" });

      const runCliAsync = vi.fn().mockImplementation(async (
        _command: string,
        _args: string[],
        _cwd: string,
        options: any,
      ) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "claude", cwd: "/", model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: rawOutput, source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: true,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      // Private chat: makeMessage uses chat.type = "private", no message_thread_id
      await engine.handleMessages([makeMessage("hello from private")]);

      const flatKey = "100";
      expect(db.getSession(flatKey, "claude")).toBe("private-session-xyz");
      // No thread-scoped key must be set
      expect(db.getSession("100:undefined:42", "claude")).toBeNull();
    });

    it("private chat /stop clears the queue for the flat chat key", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      const flatKey = "100";
      db.tryLock(flatKey); // hold lock to force queueing

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

      // Queue a private-chat message — should sit at position 1
      await engine.handleMessages([makeMessage("first message")]);
      const firstQ = client.sendMessage.mock.calls.find((c: any[]) => c[0]?.text?.includes("position 1"));
      expect(firstQ).toBeDefined();

      client.sendMessage.mockClear();

      // /stop in the same private chat clears the queue
      await engine.handleUpdate({ update_id: 2, message: makeMessage("/stop") });

      client.sendMessage.mockClear();

      // Next message after stop must show position 1, not 2
      await engine.handleMessages([makeMessage("second message")]);
      const secondQ = client.sendMessage.mock.calls.find((c: any[]) => c[0]?.text?.includes("Queued"));
      expect(secondQ).toBeDefined();
      expect(secondQ![0].text).toContain("position 1");
    });

    it("two messages in the same thread queue behind each other", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      const threadKey = "100:7";
      db.tryLock(threadKey); // hold lock

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

      // First message in thread 7 → queued at position 1
      await engine.handleMessages([makeGroupMessage("msg one", 42, 100, 7)]);
      const firstQ = client.sendMessage.mock.calls.find((c: any[]) => c[0]?.text?.includes("position 1"));
      expect(firstQ).toBeDefined();

      // Second message in the same thread 7 → queued at position 2
      await engine.handleMessages([makeGroupMessage("msg two", 42, 100, 7)]);
      const secondQ = client.sendMessage.mock.calls.find((c: any[]) => c[0]?.text?.includes("position 2"));
      expect(secondQ).toBeDefined();
    });

    it("a message in a different thread is not blocked by a lock held in thread 7", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      // Hold lock only for thread 7
      const thread7Key = "100:7";
      db.tryLock(thread7Key);

      const runCliAsync = vi.fn().mockImplementation(async (
        _command: string,
        _args: string[],
        _cwd: string,
        options: any,
      ) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "claude", cwd: "/", model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: "hi", source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: "hi", sessionId: null }));
        return { text: "hi" };
      });

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: true,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      // Message in thread 8 has a different key ("100:8") — should NOT be queued
      await engine.handleMessages([makeGroupMessage("msg in thread 8", 42, 100, 8)]);

      // runCli must have been called (not queued)
      expect(runCliAsync).toHaveBeenCalledOnce();

      // No "Queued" message should have been sent
      const queuedMsg = client.sendMessage.mock.calls.find((c: any[]) => c[0]?.text?.includes("Queued"));
      expect(queuedMsg).toBeUndefined();
    });
  });

  describe("session stored under topic-aware key after execution", () => {
    it("stores session under chatId:threadId for supergroup topic messages", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      // Claude --output-format json produces { result, session_id }
      const rawOutput = JSON.stringify({ result: "done", session_id: "thread-session-abc" });

      const runCliAsync = vi.fn().mockImplementation(async (
        _command: string,
        _args: string[],
        _cwd: string,
        options: any,
      ) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "claude", cwd: "/", model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: rawOutput, source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: true,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      await engine.handleMessages([makeGroupMessage("hello from thread")]);

      // Session must be stored under topic-aware key, not flat chatId
      const threadKey = "100:7";
      const flatKey = "100";
      expect(db.getSession(threadKey, "claude")).toBe("thread-session-abc");
      expect(db.getSession(flatKey, "claude")).toBeNull();
    });

    it("drains queued supergroup topic messages with the original topic key", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const rawOutput = JSON.stringify({ result: "done", session_id: "queued-topic-session" });
      const runCliAsync = vi.fn().mockImplementation(async (
        _command: string,
        _args: string[],
        _cwd: string,
        options: any,
      ) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "claude", cwd: "/", model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: rawOutput, source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: true,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      const topicKey = "100:7";
      db.tryLock(topicKey);
      await engine.handleMessages([makeGroupMessage("queued topic message", 42, 100, 7)]);

      db.unlock(topicKey);
      (engine as any)._drainQueue(topicKey);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(runCliAsync).toHaveBeenCalledOnce();
      expect(db.getSession(topicKey, "claude")).toBe("queued-topic-session");
      expect(db.getSession("100", "claude")).toBeNull();
    });

    it("calls onAfterExecute hook with correct parameters on successful prompt execution", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const runCli = vi.fn().mockResolvedValue("CLI execution output");
      const afterExecute = vi.fn();

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          hooks: {
            onAfterExecute: afterExecute,
          },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("run testing command")]);

      expect(runCli).toHaveBeenCalledOnce();
      expect(afterExecute).toHaveBeenCalledOnce();
      expect(afterExecute.mock.calls[0][0]).toBe("run testing command");
      expect(afterExecute.mock.calls[0][1]).toBe("CLI execution output");
      expect(afterExecute.mock.calls[0][2]).toEqual({ chatId: 100, chatKey: "100", threadId: undefined });
    });
  });

  describe("/compact command", () => {
    it("compact handler calls runCli for LLM summary and stores result", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      db.addConvTurn("100", "user", "fix the auth bug");
      db.addConvTurn("100", "assistant", "on it");

      let capturedPrompt: string | undefined;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        // For claude bot, the prompt is the last argument
        capturedPrompt = args[args.length - 1];
        return "Current objective:\n- fix auth bug\n\nDurable facts:\n- none\n\nOpen state:\n- none";
      });

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/compact")]);

      const summary = db.getLatestConvSummary("100");
      expect(summary).not.toBeNull();
      expect(summary!.summary_md).toContain("fix auth bug");
      expect(capturedPrompt).toContain("Current objective:");
      const sentBody = client.sendMessage.mock.calls.at(-1)?.[0];
      expect(sentBody.text).toContain("semantic summary");
      expect(sentBody.text).not.toContain("turn count, CLI, last message");
    });

    it("compact handler falls back to tombstone when runCli fails", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      db.addConvTurn("100", "user", "hello");
      db.addConvTurn("100", "assistant", "hi there");

      const runCli = vi.fn().mockRejectedValue(new Error("CLI timeout"));

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/compact")]);

      const summary = db.getLatestConvSummary("100");
      expect(summary).not.toBeNull();
      expect(summary!.summary_md).toContain("turns captured");
    });
  });

  describe("Agent Bridge context helper affordance", () => {
    it("injects helper env and prompt affordance when stored context exists", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      db.addConvTurn("100", "user", "remember work item #16", "claude");
      db.addConvSummary("100", 1, 1, "Current objective:\n- Keep context available.");

      let capturedPrompt = "";
      let capturedContextEnv: Record<string, string> | undefined;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[], _cwd: string, options: any) => {
        capturedPrompt = args[args.length - 1];
        capturedContextEnv = options.contextEnv;
        return "done";
      });

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("what was the work item?")]);

      expect(capturedContextEnv).toMatchObject({
        AGENT_BRIDGE_CONTEXT_AVAILABLE: "1",
        AGENT_BRIDGE_CHAT_KEY: "100",
      });
      expect(capturedContextEnv?.AGENT_BRIDGE_CONTEXT_COMMAND).toContain("agent-bridge-context");
      expect(capturedPrompt).toContain("[Agent Bridge context]");
      expect(capturedPrompt).toContain("$AGENT_BRIDGE_CONTEXT_COMMAND");
      expect(capturedPrompt).toContain("--recent 20");
      expect(capturedPrompt).toContain("Current objective:");
    });

    it("does not inject helper env or affordance when no stored context exists", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      let capturedPrompt = "";
      let capturedContextEnv: Record<string, string> | undefined;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[], _cwd: string, options: any) => {
        capturedPrompt = args[args.length - 1];
        capturedContextEnv = options.contextEnv;
        return "done";
      });

      const engine = new BridgeEngine(
        {
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(capturedContextEnv).toBeUndefined();
      expect(capturedPrompt).not.toContain("[Agent Bridge context]");
    });
  });
});
