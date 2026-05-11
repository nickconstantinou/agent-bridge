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
  getBridgeProjectDir,
  validateBridgeConfig,
} from "../src/bridge.js";
import { openDb, BridgeDb } from "../src/db.js";
import { runCli } from "../src/cli.js";
import type { TelegramMessage, BridgeConfig } from "../src/types.js";

describe("agent bridge MVP", () => {
  it("authorizes only the configured telegram user id", () => {
    const msg = { from: { id: 42 } } as any as TelegramMessage;
    expect(isAuthorizedMessage(msg, "42")).toBe(true);
    expect(isAuthorizedMessage({ from: { id: 7 } } as any, "42")).toBe(false);
    expect(isAuthorizedMessage({} as any, "42")).toBe(false);
  });

  it("extracts plain message text", () => {
    expect(extractPromptText({ text: "hello" } as any)).toBe("hello");
    expect(extractPromptText({ text: "   " } as any)).toBeNull();
    expect(extractPromptText({} as any)).toBeNull();
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
      allowedUserId: "",
      bots: { codex: { token: null, command: "codex" } },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("TELEGRAM_ALLOWED_USER_ID is required");
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
      expect(result).toContain("gemini session reset");
      expect(db.getSession("123", "gemini")).toBeNull();
    });

    it("only resets the session for the target chat, not others", () => {
      db.setSession("123", "gemini", "s-123");
      db.setSession("456", "gemini", "s-456");
      handleCommand("gemini", "/reset", { db, chatId: "123", config });
      expect(db.getSession("456", "gemini")).toBe("s-456");
    });

    it("handles /models showing current and available models", () => {
      const result = handleCommand("gemini", "/models", { db, chatId: "123", config });
      expect(result).toContain("Current: gemini-1.5-pro");
      expect(result).toContain("Available: gemini-1.5-pro");
    });

    it("handles /start", () => {
      const result = handleCommand("gemini", "/start", { db, chatId: "123", config });
      expect(result).toContain("gemini bridge ready");
    });
  });
});
