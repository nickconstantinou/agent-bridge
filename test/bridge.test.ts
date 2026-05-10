import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExecutionOptions,
  createSessionStore,
  isAuthorizedMessage,
  extractPromptText,
  buildCliInvocation,
  parseCliResult,
  createMemorySessionStore,
  createMemorySettingsStore,
  handleCommand,
  getBridgeProjectDir,
  validateBridgeConfig,
  } from "../src/bridge.js";
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

  it("gemini session invocation uses --session-id not --session", () => {
    const { args } = buildCliInvocation({
      bot: "gemini",
      prompt: "hello",
      sessionId: "session-abc-123",
      command: "gemini",
      model: null,
    });
    expect(args).toContain("--session-id");
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

  it("stores one session per bot", async () => {
    const store = createSessionStore(createMemorySessionStore({}));
    expect(await store.get("codex")).toBeNull();
    await store.set("codex", "thread-1");
    await store.set("gemini", "session-2");
    expect(await store.get("codex")).toBe("thread-1");
    expect(await store.get("gemini")).toBe("session-2");
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
            codex: { defaultModel: "gpt-4o", command: "c", token: "t" }, 
            gemini: { defaultModel: "gemini-1.5-pro", command: "g", token: "t" } 
        } 
    } as any as BridgeConfig;
    const settingsStore = createMemorySettingsStore({});
    const sessionStore = createSessionStore(createMemorySessionStore({}));
    const deps = { settingsStore, sessionStore, config };

    it("handles /reset to clear session", async () => {
      await sessionStore.set("gemini", "session-123");
      const result = await handleCommand("gemini", "/reset", deps);
      expect(result).toContain("gemini session reset");
      expect(await sessionStore.get("gemini")).toBeNull();
    });

    it("handles /models", async () => {
      const result = await handleCommand("gemini", "/models", deps);
      expect(result).toContain("Current model:");
    });

    it("handles /start", async () => {
      const result = await handleCommand("gemini", "/start", deps);
      expect(result).toContain("gemini bridge ready");
    });
  });
});
