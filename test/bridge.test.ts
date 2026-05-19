import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExecutionOptions,
  isAuthorizedMessage,
  extractPromptText,
  buildCliInvocation,
  parseCliResult,
  handleCommand,
  isBridgeCommand,
  getBridgeProjectDir,
  getCliWorkingDir,
  validateBridgeConfig,
  buildModelKeyboard,
  buildModelsText,
} from "../src/bridge.js";
import { openDb, BridgeDb } from "../src/db.js";
import { runCli } from "../src/cli.js";
import type { TelegramMessage, BridgeConfig } from "../src/types.js";

describe("agent bridge MVP", () => {
  it("authorizes only the configured telegram user id", () => {
    const allowed = new Set(["42"]);
    const msg = { from: { id: 42 } } as any as TelegramMessage;
    expect(isAuthorizedMessage(msg, allowed)).toBe(true);
    expect(isAuthorizedMessage({ from: { id: 7 } } as any, allowed)).toBe(false);
    expect(isAuthorizedMessage({} as any, allowed)).toBe(false);
  });

  it("authorizes multiple allowed user ids", () => {
    const allowed = new Set(["10", "20", "30"]);
    expect(isAuthorizedMessage({ from: { id: 10 } } as any, allowed)).toBe(true);
    expect(isAuthorizedMessage({ from: { id: 20 } } as any, allowed)).toBe(true);
    expect(isAuthorizedMessage({ from: { id: 99 } } as any, allowed)).toBe(false);
  });

  it("extracts plain message text", () => {
    expect(extractPromptText({ text: "hello" } as any)).toBe("hello");
    expect(extractPromptText({ text: "   " } as any)).toBeNull();
    expect(extractPromptText({ text: "/start" } as any)).toBeNull();
    expect(extractPromptText({} as any)).toBeNull();
  });

  it("recognizes supported bridge commands", () => {
    expect(isBridgeCommand("/start")).toBe(true);
    expect(isBridgeCommand("/models")).toBe(true);
    expect(isBridgeCommand("/memory")).toBe(true);
    expect(isBridgeCommand("hello")).toBe(false);
  });

  it("recognizes @botname-suffixed commands (group usage)", () => {
    expect(isBridgeCommand("/start@mybot")).toBe(true);
    expect(isBridgeCommand("/reset@AnotherBot")).toBe(true);
    expect(isBridgeCommand("/models@somebot")).toBe(true);
    expect(isBridgeCommand("/unknown@mybot")).toBe(false);
  });

  it("creates fresh codex invocation using exec subcommand", () => {
    const { command, args } = buildCliInvocation({
      bot: "codex",
      prompt: "hello",
      sessionId: null,
      command: "codex",
      model: null,
    });
    expect(command).toBe("codex");
    expect(args[0]).toBe("exec");
    expect(args).toContain("hello");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).not.toContain("--thread");
    expect(args).not.toContain("--output");
  });

  it("uses the bot-specific project dir when BRIDGE_PROJECT_DIR is not enough", () => {
    const prevBridgeRoot = process.env.BRIDGE_ROOT_DIR;
    const prevCodexProjectDir = process.env.CODEX_PROJECT_DIR;
    const prevGeminiProjectDir = process.env.GEMINI_PROJECT_DIR;

    const prevClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;

    process.env.BRIDGE_ROOT_DIR = "/tmp/bridge-root";
    process.env.CODEX_PROJECT_DIR = "/tmp/codex-repo";
    process.env.GEMINI_PROJECT_DIR = "/tmp/gemini-repo";
    process.env.CLAUDE_PROJECT_DIR = "/tmp/claude-repo";

    expect(getCliWorkingDir("codex")).toBe("/tmp/codex-repo");
    expect(getCliWorkingDir("gemini")).toBe("/tmp/gemini-repo");
    expect(getCliWorkingDir("claude")).toBe("/tmp/claude-repo");

    if (prevBridgeRoot === undefined) delete process.env.BRIDGE_ROOT_DIR; else process.env.BRIDGE_ROOT_DIR = prevBridgeRoot;
    if (prevCodexProjectDir === undefined) delete process.env.CODEX_PROJECT_DIR; else process.env.CODEX_PROJECT_DIR = prevCodexProjectDir;
    if (prevGeminiProjectDir === undefined) delete process.env.GEMINI_PROJECT_DIR; else process.env.GEMINI_PROJECT_DIR = prevGeminiProjectDir;
    if (prevClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prevClaudeProjectDir;
  });

  it("creates trusted codex invocation only when explicitly requested", () => {
    expect(
      buildCliInvocation({
        bot: "codex",
        prompt: "hello",
        sessionId: null,
        command: "codex",
        model: null,
        executionMode: "trusted",
      }).args,
    ).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("creates resume codex invocation using exec resume subcommand", () => {
    const { args } = buildCliInvocation({
      bot: "codex",
      prompt: "hello again",
      sessionId: "019e1299-3d2c-7f11-8194-500feee6614e",
      command: "codex",
      model: null,
    });
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args).toContain("019e1299-3d2c-7f11-8194-500feee6614e");
    expect(args).toContain("hello again");
    expect(args).not.toContain("--thread");
  });

  it("codex json invocation uses --json flag not --output", () => {
    const { args } = buildCliInvocation({
      bot: "codex",
      prompt: "hello",
      sessionId: null,
      command: "codex",
      model: null,
      outputFormat: "json",
    });
    expect(args).toContain("--json");
    expect(args).not.toContain("--output");
  });

  it("creates fresh gemini invocation with --prompt flag for non-interactive mode", () => {
    const { command, args } = buildCliInvocation({
      bot: "gemini",
      prompt: "hello",
      sessionId: null,
      command: "gemini",
      model: "gemini-pro",
    });
    expect(command).toBe("gemini");
    const idx = args.indexOf("--prompt");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("hello");
    expect(args).not.toContain("--output");
  });

  it("gemini session invocation uses --resume to continue an existing session", () => {
    const { args } = buildCliInvocation({
      bot: "gemini",
      prompt: "hello",
      sessionId: "4229bce3-5009-429e-a3cb-d1bdaa8cfeed",
      command: "gemini",
      model: null,
    });
    const idx = args.indexOf("--resume");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("4229bce3-5009-429e-a3cb-d1bdaa8cfeed");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--session");
  });

  it("gemini new session can use --session-id for stable resume", () => {
    const { args } = buildCliInvocation({
      bot: "gemini",
      prompt: "hello",
      sessionId: "4229bce3-5009-429e-a3cb-d1bdaa8cfeed",
      sessionMode: "session-id",
      command: "gemini",
      model: null,
    });
    expect(args).toContain("--session-id");
    expect(args).not.toContain("--resume");
  });

  it("creates fresh claude invocation with --print flag", () => {
    const { command, args } = buildCliInvocation({
      bot: "claude",
      prompt: "hello",
      sessionId: null,
      command: "claude",
      model: null,
    });
    expect(command).toBe("claude");
    expect(args).toContain("--print");
    expect(args[args.length - 1]).toBe("hello");
    expect(args).not.toContain("--resume");
  });

  it("creates resume claude invocation with --resume flag", () => {
    const { args } = buildCliInvocation({
      bot: "claude",
      prompt: "hello",
      sessionId: "sess-abc-123",
      command: "claude",
      model: null,
    });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-abc-123");
  });

  it("claude trusted mode uses --dangerously-skip-permissions", () => {
    const { args } = buildCliInvocation({
      bot: "claude",
      prompt: "hello",
      sessionId: null,
      command: "claude",
      model: null,
      executionMode: "trusted",
    });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("parses claude JSON output", () => {
    const stdout = JSON.stringify({
      type: "result", subtype: "success", session_id: "sess-123", result: "Hello from claude",
    });
    expect(parseCliResult({ bot: "claude", stdout })).toEqual({
      text: "Hello from claude",
      sessionId: "sess-123",
    });
  });

  it("parses claude plain text output when no JSON found", () => {
    expect(parseCliResult({ bot: "claude", stdout: "plain response" })).toEqual({
      text: "plain response",
      sessionId: null,
    });
  });

  it("kills the CLI process group on idle timeout", async () => {
    await expect(
      runCli(
        "sleep",
        ["10"],
        process.cwd(),
        { timeoutMs: 1000, idleTimeoutMs: 100, killGraceMs: 100 },
      ),
    ).rejects.toThrow(/CLI idle timeout/);
  });

  it("parses codex JSONL output with item.completed agent_message", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"abc-123"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Hello back"}}',
      '{"type":"turn.completed"}',
    ].join("\n");
    expect(parseCliResult({ bot: "codex", stdout })).toEqual({
      text: "Hello back",
      sessionId: "abc-123",
    });
  });

  it("parses codex JSONL output with response.completed event", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"xyz-789"}',
      '{"type":"response.completed","output_text":"Final answer"}',
    ].join("\n");
    expect(parseCliResult({ bot: "codex", stdout })).toEqual({
      text: "Final answer",
      sessionId: "xyz-789",
    });
  });

  it("parses gemini output", () => {
    expect(
      parseCliResult({
        bot: "gemini",
        stdout: "hi from gemini\n[session:session-123]",
      }),
    ).toEqual({ text: "hi from gemini", sessionId: "session-123" });
  });

  it("validates bridge config", () => {
    const result = validateBridgeConfig({
      allowedUserIds: new Set(),
      bots: { codex: { token: null, command: "codex" } },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("TELEGRAM_ALLOWED_USER_IDS is required");
  });

  describe("handleCommand", () => {
    const config = {
      bots: {
        codex: { modelPreference: ["gpt-4o"], command: "c", token: "t" },
        gemini: { modelPreference: ["gemini-1.5-pro"], command: "g", token: "t" },
      },
    } as any as BridgeConfig;

    let db: BridgeDb;

    beforeEach(() => { db = openDb(":memory:"); });
    afterEach(() => { db.close(); });

    it("handles /reset to clear session for the chat", () => {
      db.setSession("123", "gemini", "session-123");
      const result = handleCommand("gemini", "/reset", { db, chatId: "123", config });
      expect(result?.kind).toBe("message");
      expect(result && "text" in result ? result.text : "").toContain("gemini session reset");
      expect(db.getSession("123", "gemini")).toBeNull();
    });

    it("only resets the session for the target chat, not others", () => {
      db.setSession("123", "gemini", "s-123");
      db.setSession("456", "gemini", "s-456");
      handleCommand("gemini", "/reset", { db, chatId: "123", config });
      expect(db.getSession("456", "gemini")).toBe("s-456");
    });

    it("handles /models returning keyboard_message with current model info", () => {
      const result = handleCommand("gemini", "/models", { db, chatId: "123", config });
      expect(result?.kind).toBe("keyboard_message");
      expect(result && "text" in result ? result.text : "").toContain("gemini-1.5-pro");
      expect((result as any)?.reply_markup?.inline_keyboard).toBeDefined();
    });

    it("handles /start", () => {
      const result = handleCommand("gemini", "/start", { db, chatId: "123", config });
      expect(result?.kind).toBe("message");
      expect(result && "text" in result ? result.text : "").toContain("gemini bridge ready");
    });

    it("builds an executable memory smoke test command", () => {
      const result = handleCommand("codex", "/memory", { db, chatId: "123", config });
      expect(result?.kind).toBe("execute");
      expect(result && "prompt" in result ? result.prompt : "").toContain("agent-memory recall");
      expect(result && "prompt" in result ? result.prompt : "").toContain("MEMORY_AVAILABLE: yes|no");
    });
  });
});




describe("model keyboard", () => {
  const prefs = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];

  it("includes one button per model in the preference list", () => {
    const kb = buildModelKeyboard("codex", prefs);
    const allButtons = kb.inline_keyboard.flat();
    for (const model of prefs) {
      expect(allButtons.some((b: any) => b.text === model)).toBe(true);
    }
  });

  it("each model button carries the correct callback_data", () => {
    const kb = buildModelKeyboard("codex", prefs);
    const allButtons = kb.inline_keyboard.flat();
    for (const model of prefs) {
      const btn = allButtons.find((b: any) => b.text === model);
      expect(btn?.callback_data).toBe(`model:codex:${model}`);
    }
  });

  it("includes a Reset to Default button", () => {
    const kb = buildModelKeyboard("codex", prefs);
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.some((b: any) => b.callback_data === "model:codex:reset")).toBe(true);
  });

  it("returns an empty keyboard when preference list is empty", () => {
    const kb = buildModelKeyboard("codex", []);
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.some((b: any) => b.text === "gpt-5.5")).toBe(false);
    expect(allButtons.some((b: any) => b.callback_data === "model:codex:reset")).toBe(true);
  });
});

describe("/models command returns keyboard_message", () => {
  const makeConfig = (prefs: string[]): BridgeConfig => ({
    allowedUserId: "1",
    serviceEnvFile: null,
    serviceKind: "codex",
    pollIntervalMs: 1000,
    executionMode: "safe",
    cliTimeoutMs: 300000,
    asyncEnabled: true,
    dbPath: ":memory:",
    bots: {
      codex: { token: "t", command: "codex", modelPreference: prefs },
      gemini: { token: "t", command: "gemini", modelPreference: [] },
    },
  });

  it("returns kind keyboard_message for /models", () => {
    const result = handleCommand("codex", "/models", {
      db: { getSetting: () => null } as any,
      chatId: "1",
      config: makeConfig(["gpt-5.5", "gpt-5.4"]),
    });
    expect(result?.kind).toBe("keyboard_message");
  });

  it("keyboard_message includes reply_markup with model buttons", () => {
    const result = handleCommand("codex", "/models", {
      db: { getSetting: () => null } as any,
      chatId: "1",
      config: makeConfig(["gpt-5.5", "gpt-5.4"]),
    }) as any;
    const allButtons = result.reply_markup.inline_keyboard.flat();
    expect(allButtons.some((b: any) => b.text === "gpt-5.5")).toBe(true);
    expect(allButtons.some((b: any) => b.text === "gpt-5.4")).toBe(true);
  });

  it("keyboard_message includes text describing current model", () => {
    const result = handleCommand("codex", "/models", {
      db: { getSetting: () => "gpt-5.4" } as any,
      chatId: "1",
      config: makeConfig(["gpt-5.5", "gpt-5.4"]),
    }) as any;
    expect(result.text).toContain("gpt-5.4");
  });
});

