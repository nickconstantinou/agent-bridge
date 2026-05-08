import { describe, expect, it } from "vitest";
import {
  buildExecutionOptions,
  createSessionStore,
  isAuthorizedMessage,
  extractPromptText,
  buildCliInvocation,
  buildGeminiFallbackInvocation,
  runCodexPrompt,
  runGeminiPrompt,
  parseCliResult,
  createMemorySessionStore,
  createMemorySettingsStore,
  handleCommand,
  getBridgeProjectDir,
  getBotProjectDir,
  validateBridgeConfig,
} from "../src/bridge.js";

describe("agent bridge MVP", () => {
  it("authorizes only the configured telegram user id", () => {
    expect(isAuthorizedMessage({ from: { id: 42 } }, "42")).toBe(true);
    expect(isAuthorizedMessage({ from: { id: 7 } }, "42")).toBe(false);
    expect(isAuthorizedMessage({}, "42")).toBe(false);
  });

  it("extracts plain message text", () => {
    expect(extractPromptText({ text: "hello" })).toBe("hello");
    expect(extractPromptText({ text: "   " })).toBeNull();
    expect(extractPromptText({})).toBeNull();
  });

  it("creates fresh codex invocation", () => {
    expect(
      buildCliInvocation({
        bot: "codex",
        prompt: "hello",
        sessionId: null,
        command: "codex",
      }),
    ).toEqual({
      command: "codex",
      args: [
        "exec",
        "--skip-git-repo-check",
        "-c",
        `projects."${getBridgeProjectDir()}".trust_level="trusted"`,
        "-C",
        getBridgeProjectDir(),
        "--json",
        "hello",
      ],
    });
  });

  it("creates trusted codex invocation only when explicitly requested", () => {
    expect(
      buildCliInvocation({
        bot: "codex",
        prompt: "hello",
        sessionId: null,
        command: "codex",
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
      }),
    ).toEqual({
      command: "codex",
      args: [
        "exec",
        "--skip-git-repo-check",
        "-c",
        `projects."${getBridgeProjectDir()}".trust_level="trusted"`,
        "-C",
        getBridgeProjectDir(),
        "resume",
        "thread-123",
        "hello again",
      ],
    });
  });

  it("creates fresh gemini invocation", () => {
    expect(
      buildCliInvocation({
        bot: "gemini",
        prompt: "hello",
        sessionId: null,
        command: "gemini",
      }),
    ).toEqual({
      command: "gemini",
      args: [
        "--skip-trust",
        "--approval-mode",
        "plan",
        "--include-directories",
        getBridgeProjectDir(),
        "--output-format",
        "json",
        "-p",
        "hello",
      ],
    });
  });

  it("creates trusted gemini invocation only when explicitly requested", () => {
    expect(
      buildCliInvocation({
        bot: "gemini",
        prompt: "hello",
        sessionId: null,
        command: "gemini",
        executionMode: "trusted",
      }).args,
    ).toEqual(expect.arrayContaining(["--approval-mode", "yolo"]));
  });

  it("uses per-bot project dirs when configured", () => {
    process.env.CODEX_PROJECT_DIR = "/tmp/codex-project";
    process.env.GEMINI_PROJECT_DIR = "/tmp/gemini-project";
    expect(getBotProjectDir("codex")).toBe("/tmp/codex-project");
    expect(getBotProjectDir("gemini")).toBe("/tmp/gemini-project");
    delete process.env.CODEX_PROJECT_DIR;
    delete process.env.GEMINI_PROJECT_DIR;
  });

  it("creates resume gemini invocation", () => {
    expect(
      buildCliInvocation({
        bot: "gemini",
        prompt: "hello again",
        sessionId: "session-123",
        command: "gemini",
      }),
    ).toEqual({
      command: "gemini",
      args: [
        "--skip-trust",
        "--approval-mode",
        "plan",
        "--include-directories",
        getBridgeProjectDir(),
        "--resume",
        "session-123",
        "--output-format",
        "json",
        "-p",
        "hello again",
      ],
    });
  });

  it("creates gemini read-only fallback invocation", () => {
    expect(
      buildGeminiFallbackInvocation({
        command: "gemini",
        model: "gemini-3-flash-preview",
        prompt: "probe tools",
      }),
    ).toEqual({
      command: "gemini",
      args: [
        "--skip-trust",
        "--approval-mode",
        "plan",
        "--include-directories",
        getBridgeProjectDir(),
        "--model",
        "gemini-3-flash-preview",
        "--output-format",
        "json",
        "-p",
        "probe tools\n\nDo not use tools. Answer from inspection and reasoning only. If a tool would be required, say exactly what is blocked.",
      ],
    });
  });

  it("parses codex jsonl output", () => {
    expect(
      parseCliResult({
        bot: "codex",
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
          JSON.stringify({ type: "agent.message", message: { content: [{ type: "output_text", text: "hello back" }] } }),
        ].join("\n"),
      }),
    ).toEqual({ text: "hello back", sessionId: "thread-123" });
  });

  it("keeps mixed codex output instead of truncating plain text lines", () => {
    expect(
      parseCliResult({
        bot: "codex",
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
          JSON.stringify({ type: "agent.message", message: { content: [{ type: "output_text", text: "line one" }] } }),
          "line two",
          "line three",
        ].join("\n"),
      }),
    ).toEqual({ text: "line one\nline two\nline three", sessionId: "thread-123" });
  });

  it("parses gemini json output", () => {
    expect(
      parseCliResult({
        bot: "gemini",
        stdout: JSON.stringify({ response: "hi from gemini", session_id: "session-123" }),
      }),
    ).toEqual({ text: "hi from gemini", sessionId: "session-123" });
  });

  it("stores one session per bot", async () => {
    const store = createSessionStore(createMemorySessionStore());
    expect(await store.get("codex")).toBeNull();
    await store.set("codex", "thread-1");
    await store.set("gemini", "session-2");
    expect(await store.get("codex")).toBe("thread-1");
    expect(await store.get("gemini")).toBe("session-2");
  });

  it("validates bridge config and catches missing critical values", () => {
    const result = validateBridgeConfig({
      allowedUserId: "",
      pollIntervalMs: 0,
      bots: { codex: { token: null, command: "" }, gemini: { token: "x", command: "gemini" } },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("TELEGRAM_ALLOWED_USER_ID is required");
    expect(result.errors).toContain("POLL_INTERVAL_MS must be a positive number");
    expect(result.errors).not.toContain("TELEGRAM_BOT_TOKEN_CODEX is required");
    expect(result.errors).not.toContain("CODEX_COMMAND is required");
  });

  it("requires at least one enabled bot", () => {
    const result = validateBridgeConfig({
      allowedUserId: "42",
      pollIntervalMs: 1000,
      bots: { codex: { token: null, command: "codex" }, gemini: { token: null, command: "gemini" } },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("At least one Telegram bot token is required");
  });

  it("rejects a gemini service that loads both bot tokens or a relative command path", () => {
    const result = validateBridgeConfig({
      allowedUserId: "42",
      pollIntervalMs: 1000,
      serviceKind: "gemini",
      bots: {
        codex: { token: "codex-token", command: "codex" },
        gemini: { token: "gemini-token", command: "gemini" },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("BRIDGE_ENV_FILE for gemini must not load CODEX_TOKEN");
    expect(result.errors).toContain("GEMINI_COMMAND must be an absolute path in the Gemini service");
  });

  it("rejects a missing absolute gemini binary before startup", () => {
    const result = validateBridgeConfig({
      allowedUserId: "42",
      pollIntervalMs: 1000,
      serviceKind: "gemini",
      bots: {
        codex: { token: null, command: "codex" },
        gemini: { token: "gemini-token", command: "/definitely/not/present" },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("GEMINI_COMMAND is not executable or does not exist"))).toBe(true);
  });

  it("validates execution mode", () => {
    expect(buildExecutionOptions(undefined)).toEqual({ executionMode: "safe" });
    expect(buildExecutionOptions("safe")).toEqual({ executionMode: "safe" });
    expect(buildExecutionOptions("trusted")).toEqual({ executionMode: "trusted" });
    expect(() => buildExecutionOptions("yolo")).toThrow(/BRIDGE_EXECUTION_MODE/);
  });

  describe("handleCommand", () => {
    const config = { bots: { codex: { defaultModel: "gpt-4o" }, gemini: { defaultModel: "gemini-1.5-pro" } } };
    const settingsStore = createMemorySettingsStore();
    const sessionStore = createSessionStore(createMemorySessionStore());
    const deps = { settingsStore, sessionStore, config };

    it("handles /reset to clear session", async () => {
      await sessionStore.set("gemini", "session-123");
      const result = await handleCommand("gemini", "/reset", deps);
      expect(result).toEqual({ text: "gemini session reset" });
      expect(await sessionStore.get("gemini")).toBeNull();
    });

    it("handles /model reset", async () => {
      await settingsStore.write({ gemini: "custom-model" });
      const result = await handleCommand("gemini", "/model reset", deps);
      expect(result).toEqual({ text: "gemini default model reset to env/default" });
      expect((await settingsStore.read()).gemini).toBeNull();
    });

    it("handles /models", async () => {
      const result = await handleCommand("gemini", "/models", deps);
      expect(result.text).toContain("gemini model settings");
      expect(result.reply_markup).toBeDefined();
    });

  it("handles /start", async () => {
      const result = await handleCommand("gemini", "/start", deps);
      expect(result.text).toContain("gemini bridge ready");
      expect(result.text).toContain("/models");
    });
  });
});
