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

  it("creates fresh codex invocation", () => {
    expect(
      buildCliInvocation({
        bot: "codex",
        prompt: "hello",
        sessionId: null,
        command: "codex",
        model: null,
      }),
    ).toEqual({
      command: "codex",
      args: ["hello"],
    });
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

  it("creates resume codex invocation", () => {
    expect(
      buildCliInvocation({
        bot: "codex",
        prompt: "hello again",
        sessionId: "thread-123",
        command: "codex",
        model: null,
      }),
    ).toEqual({
      command: "codex",
      args: ["--thread", "thread-123", "hello again"],
    });
  });

  it("creates fresh gemini invocation", () => {
    expect(
      buildCliInvocation({
        bot: "gemini",
        prompt: "hello",
        sessionId: null,
        command: "gemini",
        model: "gemini-pro",
      }),
    ).toEqual({
      command: "gemini",
      args: ["--model", "gemini-pro", "hello"],
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

  it("parses codex output", () => {
    expect(
      parseCliResult({
        bot: "codex",
        stdout: "hello back\n[thread:thread-123]",
      }),
    ).toEqual({ text: "hello back", sessionId: "thread-123" });
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
