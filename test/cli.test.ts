import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { runCli, runCliAsync, abortCliProcess, shutdownCliProcesses, isCapacityExhaustedError, getNextFallbackModel, toAntigravityModelLabel, setAntigravityModel, parseCliResult, toUserMessage, buildCliInvocation, buildSafeChildEnv } from "../src/cli.js";
import { isBridgeCommand, handleCommand } from "../src/commands.js";
import { openDb } from "../src/db.js";
import type { BridgeConfig } from "../src/types.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("runCliAsync idle timeout", () => {
  it("rejects with idle timeout when process is silent and idleTimeoutMs is set", async () => {
    await expect(
      runCliAsync("bash", ["-lc", "sleep 5"], process.cwd(), {
        timeoutMs: 500,
        idleTimeoutMs: 50,
        killGraceMs: 25,
      }),
    ).rejects.toThrow(/idle timeout/i);
  }, 2000);

  it("aborts agy when planner churn persists without usable output", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "agy-stall-"));
    const scriptPath = join(tempDir, "agy");
    const logPath = join(tempDir, "agy.log");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\necho 'PlannerResponse without ModifiedResponse encountered' > "$2"\nsleep 5\n`,
      { mode: 0o755 },
    );

    const previous = process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS;
    process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS = "200";
    try {
      await expect(
        runCliAsync(scriptPath, ["--log-file", logPath, "--print", "hello"], process.cwd(), {
          timeoutMs: 5_000,
          idleTimeoutMs: 5_000,
          killGraceMs: 25,
        }),
      ).rejects.toThrow(/stalled in planner loop/i);
    } finally {
      if (previous === undefined) delete process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS;
      else process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS = previous;
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 4000);
});

describe("CLI Runner", () => {
  it("buildSafeChildEnv keeps context helper env while stripping Telegram secrets", () => {
    const env = buildSafeChildEnv({
      TELEGRAM_BOT_TOKEN: "secret",
      AGENT_BRIDGE_CONTEXT_AVAILABLE: "1",
      AGENT_BRIDGE_CONTEXT_COMMAND: "agent-bridge-context",
      AGENT_BRIDGE_CHAT_KEY: "chat:1",
    });

    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.AGENT_BRIDGE_CONTEXT_AVAILABLE).toBe("1");
    expect(env.AGENT_BRIDGE_CONTEXT_COMMAND).toBe("agent-bridge-context");
    expect(env.AGENT_BRIDGE_CHAT_KEY).toBe("chat:1");
  });

  it("passes contextEnv into child processes", async () => {
    const output = await runCli(
      process.execPath,
      ["-e", "console.log(process.env.AGENT_BRIDGE_CONTEXT_AVAILABLE + ':' + process.env.AGENT_BRIDGE_CHAT_KEY)"],
      process.cwd(),
      { contextEnv: { AGENT_BRIDGE_CONTEXT_AVAILABLE: "1", AGENT_BRIDGE_CHAT_KEY: "chat:1" } } as any,
    );

    expect(output.trim()).toBe("1:chat:1");
  });

  it("runs a simple command and returns stdout", async () => {
    const output = await runCli("echo", ["hello"], process.cwd());
    expect(output.trim()).toBe("hello");
  });

  it("closes stdin so commands that wait for input can finish", async () => {
    const output = await runCli("bash", ["-lc", "read -r _ || true; echo done"], process.cwd(), {
      timeoutMs: 2000,
    });
    expect(output).toContain("done");
  }, 5000);

  it("logs spawn details for debugging", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCli("echo", ["hello world"], process.cwd(), { chatId: "debug-chat" });
    expect(spy.mock.calls.some((call) => String(call[0]).includes("[spawn]") && String(call[0]).includes("debug-chat"))).toBe(true);
    spy.mockRestore();
  });

  it("throws on non-zero exit code", async () => {
    await expect(runCli("false", [], process.cwd())).rejects.toThrow();
  });

  it("handles async progress", async () => {
    const chunks: string[] = [];
    const result = await runCliAsync("echo", ["hello world"], process.cwd(), {
      onProgress: (c) => chunks.push(c),
    });
    expect(result.text).toContain("hello world");
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("resolves cleanly when aborted mid-run", async () => {
    const chatId = "test-cancel-midrun";
    const p = runCliAsync("sleep", ["10"], process.cwd(), { chatId });
    await new Promise((r) => setTimeout(r, 50));
    abortCliProcess(chatId);
    await expect(p).resolves.toMatchObject({ text: expect.any(String) });
  }, 5000);
});

describe("abortCliProcess", () => {
  afterEach(() => {
    shutdownCliProcesses();
  });

  it("returns false when no process is registered for the chatId", () => {
    expect(abortCliProcess("chat-does-not-exist")).toBe(false);
  });

  it("resolves cleanly when process is killed via abortCliProcess (runCliAsync)", async () => {
    const chatId = "test-abort-async";
    const p = runCliAsync("sleep", ["10"], process.cwd(), { chatId });
    // Give spawn a tick to register
    await new Promise((r) => setTimeout(r, 50));
    const aborted = abortCliProcess(chatId);
    expect(aborted).toBe(true);
    // Should resolve (not reject) with partial stdout
    await expect(p).resolves.toMatchObject({ text: expect.any(String) });
  }, 5000);

  it("resolves cleanly when process is killed via abortCliProcess (runCli)", async () => {
    const chatId = "test-abort-sync";
    const p = runCli("sleep", ["10"], process.cwd(), { chatId });
    await new Promise((r) => setTimeout(r, 50));
    const aborted = abortCliProcess(chatId);
    expect(aborted).toBe(true);
    await expect(p).resolves.toEqual(expect.any(String));
  }, 5000);

  it("returns false for already-completed process", async () => {
    const chatId = "test-abort-done";
    await runCli("echo", ["hi"], process.cwd(), { chatId });
    expect(abortCliProcess(chatId)).toBe(false);
  });

  it("kills all tracked processes during shutdown", async () => {
    const asyncPromise = runCliAsync("sleep", ["10"], process.cwd(), { chatId: "shutdown-async" });
    const syncPromise = runCli("sleep", ["10"], process.cwd(), { chatId: "shutdown-sync" });
    await new Promise((r) => setTimeout(r, 50));

    expect(shutdownCliProcesses()).toBe(2);
    await expect(asyncPromise).resolves.toMatchObject({ text: expect.any(String) });
    await expect(syncPromise).resolves.toEqual(expect.any(String));
  }, 5000);
});

describe("model fallback", () => {
  it("detects capacity-exhausted errors by message content", () => {
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: No capacity available for model gemini-2.5-flash")
    )).toBe(true);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: MODEL_CAPACITY_EXHAUSTED")
    )).toBe(true);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: You've hit your limit · resets 2:40am (Europe/London)")
    )).toBe(true);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: You've hit your session limit · resets 1pm (Europe/London)")
    )).toBe(true);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: You've hit your usage limit. Upgrade to Pro...")
    )).toBe(true);
    expect(isCapacityExhaustedError(
      new Error(`CLI exited with code 1: {"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You've hit your limit · resets 2:40am (Europe/London)"}`)
    )).toBe(true);
    expect(isCapacityExhaustedError(new Error("CLI hard timeout after 120000ms"))).toBe(false);
    expect(isCapacityExhaustedError(new Error("Network error"))).toBe(false);
  });

  it("returns the next model in the preference list", () => {
    const prefs = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
    expect(getNextFallbackModel("gemini-2.5-flash", prefs)).toBe("gemini-2.5-flash-lite");
  });

  it("returns null when already at the last model in the list", () => {
    const prefs = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
    expect(getNextFallbackModel("gemini-2.5-flash-lite", prefs)).toBeNull();
  });

  it("returns null when current model is not in the preference list", () => {
    const prefs = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
    expect(getNextFallbackModel("gemini-unknown", prefs)).toBeNull();
  });

  it("returns null when current model is null", () => {
    expect(getNextFallbackModel(null, ["gemini-2.5-flash", "gemini-2.5-flash-lite"])).toBeNull();
  });

  it("returns null when preference list has only one entry", () => {
    expect(getNextFallbackModel("gemini-2.5-flash", ["gemini-2.5-flash"])).toBeNull();
  });

  it("walks a three-model chain correctly", () => {
    const prefs = ["a", "b", "c"];
    expect(getNextFallbackModel("a", prefs)).toBe("b");
    expect(getNextFallbackModel("b", prefs)).toBe("c");
    expect(getNextFallbackModel("c", prefs)).toBeNull();
  });

  it("aborts agy when planner churn persists without usable output", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "agy-stall-cli-"));
    const fakeAgy = join(tempDir, "agy");
    const tmpLog = join(tempDir, "agy.log");
    writeFileSync(
      fakeAgy,
      `#!/usr/bin/env bash
printf 'PlannerResponse without ModifiedResponse encountered\\n' >> "$2"
sleep 5
`,
      { mode: 0o755 },
    );

    const previous = process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS;
    process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS = "200";
    try {
      await expect(
        runCliAsync(
          fakeAgy,
          ["--log-file", tmpLog, "--print", "hello"],
          process.cwd(),
          {
            timeoutMs: 5_000,
            idleTimeoutMs: 5_000,
            killGraceMs: 25,
          },
        ),
      ).rejects.toThrow(/stalled in planner loop/i);
    } finally {
      if (previous === undefined) delete process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS;
      else process.env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS = previous;
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 4000);
});

describe("cli.ts signal handler hygiene", () => {
  it("does not register SIGTERM or SIGINT handlers at module scope", () => {
    const src = readFileSync("src/cli.ts", "utf-8");
    expect(src).not.toMatch(/process\.once\(["']SIGTERM["']/);
    expect(src).not.toMatch(/process\.once\(["']SIGINT["']/);
  });

  it("killWithGrace schedules SIGKILL and clears it via child close handler", () => {
    const src = readFileSync("src/cli.ts", "utf-8");
    expect(src).toContain("killWithGrace");
    expect(src).toMatch(/child\.once\(["']close["'][^}]*clearTimeout/s);
  });
});

describe("dead code removed from cli.ts", () => {
  it("buildGeminiFallbackInvocation is not present", () => {
    const src = readFileSync("src/cli.ts", "utf-8");
    expect(src).not.toContain("buildGeminiFallbackInvocation");
  });

  it("parseGeminiAcpResult is not present", () => {
    const src = readFileSync("src/cli.ts", "utf-8");
    expect(src).not.toContain("parseGeminiAcpResult");
  });
});

describe("antigravity model mapping and settings override", () => {
  it("maps model IDs to Agy display names", () => {
    expect(toAntigravityModelLabel("gemini-3.5-flash-high")).toBe("Gemini 3.5 Flash (High)");
    expect(toAntigravityModelLabel("gemini-3.5-flash-medium")).toBe("Gemini 3.5 Flash (Medium)");
    expect(toAntigravityModelLabel("gemini-3.1-pro-high")).toBe("Gemini 3.1 Pro (High)");
    expect(toAntigravityModelLabel("gemini-3.1-pro-low")).toBe("Gemini 3.1 Pro (Low)");
    expect(toAntigravityModelLabel("claude-4.6-sonnet-thinking")).toBe("Claude Sonnet 4.6 (Thinking)");
    expect(toAntigravityModelLabel("claude-4.6-opus-thinking")).toBe("Claude Opus 4.6 (Thinking)");
  });

  it("handles unrecognized slugs gracefully using backup formatter", () => {
    expect(toAntigravityModelLabel("gemini-4.0-pro-high")).toBe("Gemini 4.0 Pro (High)");
    expect(toAntigravityModelLabel("claude-5.0-sonnet-thinking")).toBe("Claude 5.0 Sonnet (Thinking)");
  });

  it("leaves already-formatted display labels alone", () => {
    expect(toAntigravityModelLabel("Gemini 3.5 Flash (High)")).toBe("Gemini 3.5 Flash (High)");
    expect(toAntigravityModelLabel("Claude Sonnet 4.6 (Thinking)")).toBe("Claude Sonnet 4.6 (Thinking)");
  });

  it("writes mapped model names to settings.json using setAntigravityModel", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "agy-settings-test-"));
    try {
      // 1. Initial write to new settings
      setAntigravityModel("gemini-3.5-flash-high", tempDir);
      const settingsPath = join(tempDir, ".gemini", "antigravity-cli", "settings.json");
      let data = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(data.model).toBe("Gemini 3.5 Flash (High)");

      // 2. Overwrite with another model
      setAntigravityModel("claude-4.6-opus-thinking", tempDir);
      data = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(data.model).toBe("Claude Opus 4.6 (Thinking)");

      // 3. Reset (pass null) deletes the model key
      setAntigravityModel(null, tempDir);
      data = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(data.model).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws error when Antigravity returns empty response", () => {
    expect(() => parseCliResult({ bot: "antigravity", stdout: "" })).toThrow(/empty response|JSON parse failed/i);
    expect(() => parseCliResult({ bot: "antigravity", stdout: "   " })).toThrow(/empty response|JSON parse failed/i);
  });

  it("extracts response from clean JSON output", () => {
    const stdout = JSON.stringify({ reasoning: "I checked the config.", response: "The server is running on port 3000." });
    const result = parseCliResult({ bot: "antigravity", stdout });
    expect(result.text).toBe("The server is running on port 3000.");
  });

  it("extracts response from pretty-printed JSON output", () => {
    const stdout = JSON.stringify({ reasoning: "multi-step work done", response: "Done. **3 files** updated." }, null, 2);
    const result = parseCliResult({ bot: "antigravity", stdout });
    expect(result.text).toBe("Done. **3 files** updated.");
  });

  it("extracts response from JSON inside a markdown code fence", () => {
    const stdout = "```json\n" + JSON.stringify({ reasoning: "internal notes", response: "Answer here." }) + "\n```";
    const result = parseCliResult({ bot: "antigravity", stdout });
    expect(result.text).toBe("Answer here.");
  });

  it("extracts response when JSON is surrounded by extra text", () => {
    const inner = JSON.stringify({ reasoning: "thinking...", response: "Clean answer." });
    const stdout = `Here is my output:\n${inner}\nEnd of output.`;
    const result = parseCliResult({ bot: "antigravity", stdout });
    expect(result.text).toBe("Clean answer.");
  });

  it("extracts response when preceding tool output contains braces", () => {
    // Reproduces the reasoning-leak bug: tool-call outputs containing "}" before
    // the response JSON cause strategy-3 (lastIndexOf) to span multiple objects
    // → JSON.parse fails → raw blob returned to Telegram.
    const inner = JSON.stringify({ reasoning: "done", response: "Fixed." });
    const stdout = `Tool result: {status: "ok"}\n${inner}`;
    const result = parseCliResult({ bot: "antigravity", stdout });
    expect(result.text).toBe("Fixed.");
  });

  it("falls back to *** delimiter when JSON parse fails", () => {
    // Reproduces the observed bug: Agy appended *** to the last STATUS line
    // instead of putting it on its own line, causing the fallback path to return
    // all STATUS lines as the final response.
    const stdout = [
      "STATUS: searching codebase",
      "STATUS: listing directory",
      "STATUS: compiling remediation options***",
      "1. Do the thing",
      "   - Command: systemctl restart foo",
    ].join("\n");
    const result = parseCliResult({ bot: "antigravity", stdout });
    expect(result.text).not.toMatch(/^STATUS:/m);
    expect(result.text).toContain("1. Do the thing");
  });

  it("strips STATUS lines from final text even when *** is on its own line", () => {
    // Defence-in-depth: if Agy somehow emits STATUS lines after ***, strip them.
    const stdout = [
      "STATUS: working",
      "***",
      "STATUS: should not appear",
      "The real answer.",
    ].join("\n");
    const result = parseCliResult({ bot: "antigravity", stdout });
    expect(result.text).not.toMatch(/^STATUS:/m);
    expect(result.text).toContain("The real answer.");
  });

  it("strips STATUS lines in fallback path when no *** present", () => {
    const stdout = [
      "🧠 Memory Loaded: some context",
      "STATUS: looking things up",
      "STATUS: done",
      "Here is the answer.",
    ].join("\n");
    const result = parseCliResult({ bot: "antigravity", stdout });
    expect(result.text).not.toMatch(/^STATUS:/m);
    expect(result.text).toContain("Here is the answer.");
  });

  it("extracts RESOURCE_EXHAUSTED log errors, de-duplicates them, and identifies capacity exhaustion", () => {
    const logErr = "E0526 15:21:41.395478 3605783 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h.: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h.";
    
    let caught: any;
    try {
      parseCliResult({ bot: "antigravity", stdout: "", logContent: logErr });
    } catch (err: any) {
      caught = err;
    }
    
    expect(caught).toBeDefined();
    expect(isCapacityExhaustedError(caught)).toBe(true);
    
    // Test that toUserMessage outputs the clean, de-duplicated message
    const userMsg = toUserMessage(caught);
    expect(userMsg).toBe("agent executor error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h.");
  });
});

// Steps 3, 4, 5, 8 — attachment + outputDir support in buildCliInvocation

describe("buildCliInvocation — attachment injection", () => {
  const base = { prompt: "hello", sessionId: null, command: "agy", model: null };

  it("agy: appends attachment annotation lines to prompt for each file", () => {
    const { args } = buildCliInvocation({
      ...base,
      bot: "antigravity",
      attachments: ["/tmp/x.jpg", "/tmp/y.png"],
    });
    const prompt = args[args.length - 1];
    expect(prompt).toContain("[Attached file saved at: /tmp/x.jpg]");
    expect(prompt).toContain("[Attached file saved at: /tmp/y.png]");
  });

  it("agy: no annotation when attachments is empty", () => {
    const { args } = buildCliInvocation({
      ...base,
      bot: "antigravity",
      attachments: [],
    });
    const prompt = args[args.length - 1];
    expect(prompt).not.toContain("[Attached file saved at:");
  });

  it("codex: adds -i flag per attachment before prompt on new session", () => {
    const { args } = buildCliInvocation({
      ...base,
      bot: "codex",
      command: "codex",
      attachments: ["/tmp/a.png", "/tmp/b.png"],
    });
    expect(args).toContain("-i");
    const iIdx1 = args.indexOf("-i");
    expect(args[iIdx1 + 1]).toBe("/tmp/a.png");
    const iIdx2 = args.indexOf("-i", iIdx1 + 1);
    expect(args[iIdx2 + 1]).toBe("/tmp/b.png");
  });

  it("codex: no -i flags when attachments is empty", () => {
    const { args } = buildCliInvocation({
      ...base,
      bot: "codex",
      command: "codex",
      attachments: [],
    });
    expect(args).not.toContain("-i");
  });

  it("codex: starts a fresh invocation with -i when attachments are present on a resumed chat", () => {
    const result = buildCliInvocation({
      ...base,
      bot: "codex",
      command: "codex",
      sessionId: "sess_abc",
      attachments: ["/tmp/img.png"],
    });
    const { args } = result;
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("resume");
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe("/tmp/img.png");
    expect(args.slice(-2)).toEqual(["--", "-"]);
    expect(result.stdin).toContain("hello");
  });

  it("claude with attachments: returns stdin field with stream-json payload and uses stream-json args", async () => {
    const { mkdtemp: mkd, writeFile: wf, rm: rmf } = await import("node:fs/promises");
    const { join: pjoin } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkd(pjoin(tmpdir(), "bridge-test-"));
    const imgPath = pjoin(dir, "img.png");
    await wf(imgPath, Buffer.from([137, 80, 78, 71]));
    try {
      const result = buildCliInvocation({
        ...base,
        bot: "claude",
        command: "claude",
        attachments: [imgPath],
      });
      expect(result.args).toContain("--input-format");
      expect(result.args).toContain("stream-json");
      expect(result.args).toContain("--output-format");
      expect(result.args).toContain("--verbose");
      expect(result.stdin).toBeDefined();
      const payload = JSON.parse(result.stdin!);
      expect(payload.type).toBe("user");
      expect(Array.isArray(payload.message.content)).toBe(true);
    } finally {
      await rmf(dir, { recursive: true, force: true });
    }
  });

  it("all bots: appends outputDir instruction to prompt when outputDir is set", () => {
    for (const bot of ["antigravity", "codex", "claude"] as const) {
      const { args } = buildCliInvocation({
        ...base,
        bot,
        command: "cmd",
        outputDir: "/tmp/bridge-out/42",
      });
      const prompt = args[args.length - 1];
      expect(prompt).toContain("If you are explicitly asked to share or generate a file for the user, save it to /tmp/bridge-out/42");
    }
  });

  it("outputDir instruction states that the bridge handles delivery and omit file paths", () => {
    for (const bot of ["antigravity", "codex", "claude"] as const) {
      const { args } = buildCliInvocation({
        ...base,
        bot,
        command: "cmd",
        outputDir: "/tmp/bridge-out/42",
      });
      const prompt = args[args.length - 1];
      expect(prompt).toContain("the bridge handles delivery");
      expect(prompt).toMatch(/omit.*file path|file path.*omit/i);
    }
  });

  it("wraps prompts with optimized Telegram response style constraints", () => {
    const { args } = buildCliInvocation({
      ...base,
      bot: "codex",
      command: "codex",
    });
    const prompt = args[args.length - 1];
    expect(prompt).toContain("Telegram response style:");
    expect(prompt).toContain("Never drop critical facts");
    expect(prompt).toContain("Retain all specific commands, signals, file paths, error codes");
    expect(prompt).toContain("Skip all throat-clearing");
    expect(prompt).toContain("Avoid Markdown links and em dashes");
  });
});

describe("buildCliInvocation — effort flags", () => {
  const base = { prompt: "hello", sessionId: null, model: null };

  it("maps Codex effort to model_reasoning_effort config", () => {
    const { args } = buildCliInvocation({
      ...base,
      bot: "codex",
      command: "codex",
      effort: "high",
    });
    expect(args.slice(0, 3)).toEqual(["exec", "-c", "model_reasoning_effort=\"high\""]);
  });

  it("maps Claude effort to --effort", () => {
    const { args } = buildCliInvocation({
      ...base,
      bot: "claude",
      command: "claude",
      effort: "xhigh",
    });
    expect(args.slice(0, 2)).toEqual(["--effort", "xhigh"]);
  });

  it("leaves Agy effort unimplemented because the CLI has no effort flag", () => {
    const { args } = buildCliInvocation({
      ...base,
      bot: "antigravity",
      command: "agy",
      effort: "max",
    });
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("model_reasoning_effort=\"max\"");
  });
});

describe("buildSafeChildEnv", () => {
  it("strips TELEGRAM_BOT_TOKEN_* vars from the env", async () => {
    const { buildSafeChildEnv } = await import("../src/cli.js");
    const env = buildSafeChildEnv({
      PATH: "/usr/bin",
      TELEGRAM_BOT_TOKEN_CLAUDE: "secret1",
      TELEGRAM_BOT_TOKEN_CODEX: "secret2",
      TELEGRAM_BOT_TOKEN_ANTIGRAVITY: "secret3",
      HOME: "/home/user",
    });
    expect(env.TELEGRAM_BOT_TOKEN_CLAUDE).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN_CODEX).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN_ANTIGRAVITY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
  });

  it("also strips TELEGRAM_BOT_TOKEN (unqualified) and TELEGRAM_ALLOWED_USER_IDS", async () => {
    const { buildSafeChildEnv } = await import("../src/cli.js");
    const env = buildSafeChildEnv({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      OTHER: "keep",
    });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_ALLOWED_USER_IDS).toBeUndefined();
    expect(env.OTHER).toBe("keep");
  });
});

describe("scrubOutputDir", () => {
  it("removes lines that contain the output dir path", async () => {
    const { scrubOutputDir } = await import("../src/cli.js");
    const text = "Image generated.\n\nSaved to /tmp/bridge-out/codex-42/image.png\n\nHere is your result.";
    expect(scrubOutputDir(text, "/tmp/bridge-out/codex-42")).toBe("Image generated.\n\nHere is your result.");
  });

  it("removes the entire line when path appears mid-sentence", async () => {
    const { scrubOutputDir } = await import("../src/cli.js");
    const text = "Done.\nFile written: /tmp/bridge-out/codex-42/out.jpg\nEnjoy.";
    expect(scrubOutputDir(text, "/tmp/bridge-out/codex-42")).toBe("Done.\nEnjoy.");
  });

  it("collapses multiple blank lines left by removed lines", async () => {
    const { scrubOutputDir } = await import("../src/cli.js");
    const text = "A\n\n/tmp/bridge-out/codex-42/x.png\n\nB";
    expect(scrubOutputDir(text, "/tmp/bridge-out/codex-42")).toBe("A\n\nB");
  });

  it("returns text unchanged when outDir is null", async () => {
    const { scrubOutputDir } = await import("../src/cli.js");
    const text = "Some text with no path.";
    expect(scrubOutputDir(text, null)).toBe(text);
  });
});

describe("redactArgs — spawn log prompt redaction", () => {
  it("keeps short args intact", async () => {
    const { redactArgs } = await import("../src/cli.js");
    const args = ["--print", "--model", "claude-sonnet-4-6", "--output-format", "json"];
    expect(redactArgs(args)).toEqual(args);
  });

  it("redacts args longer than 100 chars with a placeholder", async () => {
    const { redactArgs } = await import("../src/cli.js");
    const longPrompt = "A".repeat(200);
    const result = redactArgs(["--print", longPrompt]);
    expect(result[0]).toBe("--print");
    expect(result[1]).toMatch(/^\[prompt: \d+chars\]$/);
    expect(result[1]).not.toContain("A");
  });

  it("placeholder includes the original char count", async () => {
    const { redactArgs } = await import("../src/cli.js");
    const result = redactArgs(["A".repeat(150)]);
    expect(result[0]).toContain("150chars");
  });

  it("does not redact args exactly at the 100-char boundary", async () => {
    const { redactArgs } = await import("../src/cli.js");
    const arg = "x".repeat(100);
    expect(redactArgs([arg])).toEqual([arg]);
  });

  it("redacts args over 100 chars (101+)", async () => {
    const { redactArgs } = await import("../src/cli.js");
    const arg = "x".repeat(101);
    expect(redactArgs([arg])[0]).toMatch(/^\[prompt:/);
  });
});

describe("normalizeCliArgs — CLI argument translator", () => {
  it("keeps arguments unchanged for Claude commands", async () => {
    const { normalizeCliArgs } = await import("../src/cli.js");
    const args = ["--print", "--output-format", "text", "--permission-mode", "acceptEdits", "hello"];
    expect(normalizeCliArgs("claude", args)).toEqual(args);
    expect(normalizeCliArgs("/path/to/claude-cli", args)).toEqual(args);
  });

  it("normalizes arguments for Antigravity command", async () => {
    const { normalizeCliArgs } = await import("../src/cli.js");
    const args = ["--print", "--output-format", "text", "--permission-mode", "acceptEdits", "hello"];
    expect(normalizeCliArgs("agy", args)).toEqual(["--dangerously-skip-permissions", "--print", "hello"]);
    expect(normalizeCliArgs("/usr/local/bin/antigravity", args)).toEqual(["--dangerously-skip-permissions", "--print", "hello"]);
  });

  it("normalizes arguments for Codex command", async () => {
    const { normalizeCliArgs } = await import("../src/cli.js");
    const args = ["--print", "--output-format", "text", "--permission-mode", "acceptEdits", "hello"];
    expect(normalizeCliArgs("codex", args)).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "hello"]);
    expect(normalizeCliArgs("/opt/codex/bin/codex", args)).toEqual(["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "hello"]);
  });

  it("preserves Codex trusted bypass when normalizing already-built Codex args", async () => {
    const { normalizeCliArgs } = await import("../src/cli.js");
    const args = ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--json", "hello"];
    expect(normalizeCliArgs("codex", args)).toEqual([
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--json",
      "hello",
    ]);
  });

  it("preserves Codex effort config during argument translation", async () => {
    const { normalizeCliArgs } = await import("../src/cli.js");
    const args = ["--print", "-c", "model_reasoning_effort=\"high\"", "hello"];
    expect(normalizeCliArgs("codex", args)).toEqual([
      "exec",
      "-c",
      "model_reasoning_effort=\"high\"",
      "--skip-git-repo-check",
      "hello",
    ]);
  });

  it("handles basic arguments without permissions", async () => {
    const { normalizeCliArgs } = await import("../src/cli.js");
    const args = ["--print", "--output-format", "text", "hello"];
    expect(normalizeCliArgs("agy", args)).toEqual(["--print", "hello"]);
    expect(normalizeCliArgs("codex", args)).toEqual(["exec", "--skip-git-repo-check", "hello"]);
  });

  it("translates --output-format json to --json for Codex and ignores it for Antigravity", async () => {
    const { normalizeCliArgs } = await import("../src/cli.js");
    const args1 = ["--print", "--output-format", "json", "hello"];
    expect(normalizeCliArgs("codex", args1)).toEqual(["exec", "--skip-git-repo-check", "--json", "hello"]);
    expect(normalizeCliArgs("agy", args1)).toEqual(["--print", "hello"]);

    const args2 = ["--print", "--output-format=json", "hello"];
    expect(normalizeCliArgs("codex", args2)).toEqual(["exec", "--skip-git-repo-check", "--json", "hello"]);
    expect(normalizeCliArgs("agy", args2)).toEqual(["--print", "hello"]);
  });

  it("preserves conversation, log-file, and print-timeout for Antigravity", async () => {
    const { normalizeCliArgs } = await import("../src/cli.js");
    const args = [
      "--conversation", "abc-123",
      "--dangerously-skip-permissions",
      "--log-file", "/tmp/log.txt",
      "--print-timeout", "60s",
      "--print", "hello"
    ];
    expect(normalizeCliArgs("agy", args)).toEqual([
      "--conversation", "abc-123",
      "--dangerously-skip-permissions",
      "--log-file", "/tmp/log.txt",
      "--print-timeout", "60s",
      "--print", "hello"
    ]);
  });

  it("preserves resume, model, and attachments for Codex", async () => {
    const { normalizeCliArgs } = await import("../src/cli.js");
    const args = [
      "exec", "resume", "session-xyz",
      "--model", "gpt-5.5",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--json",
      "-i", "img1.png",
      "-i", "img2.jpg",
      "--", "-"
    ];
    expect(normalizeCliArgs("codex", args)).toEqual([
      "exec", "resume", "session-xyz",
      "--model", "gpt-5.5",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--json",
      "-i", "img1.png",
      "-i", "img2.jpg",
      "--", "-"
    ]);
  });
});

describe("wrapAntigravityPrompt — liveness and narration", () => {
  const base = { prompt: "do something long", sessionId: null, command: "agy", model: null };

  function getAgyPrompt(): string {
    const { args } = buildCliInvocation({ ...base, bot: "antigravity" });
    return args[args.length - 1];
  }

  it("does not contain the old LIVENESS RULE idle-timeout coupling", () => {
    const prompt = getAgyPrompt();
    expect(prompt).not.toContain("LIVENESS RULE");
    expect(prompt).not.toContain("idle timeout termination");
  });

  it("does not instruct bare PING output", () => {
    const prompt = getAgyPrompt();
    expect(prompt).not.toMatch(/'PING'/);
  });

  it("contains a JSON output instruction instead of STATUS narration", () => {
    const prompt = getAgyPrompt();
    expect(prompt).toContain('"response"');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).not.toContain("STATUS:");
  });
});

// Minimal config stub for command handler tests
const stubConfig: BridgeConfig = {
  allowedUserIds: new Set(),
  serviceEnvFile: null,
  serviceKind: null,
  pollIntervalMs: 1000,
  executionMode: "safe",
  asyncEnabled: false,
  dbPath: ":memory:",
  bots: {
    codex: { token: undefined, command: "codex", modelPreference: [] },
    antigravity: { token: undefined, command: "agy", modelPreference: [] },
    claude: { token: undefined, command: "claude", modelPreference: [] },
  },
};

describe("/compact command", () => {
  it("is recognised as a bridge command", () => {
    expect(isBridgeCommand("/compact")).toBe(true);
  });

  it("returns compact result kind", () => {
    const db = openDb(":memory:");
    const result = handleCommand("claude", "/compact", { db, chatId: "chat:1", config: stubConfig });
    expect(result?.kind).toBe("compact");
  });
});

describe("/context command", () => {
  it("is recognised as a bridge command", () => {
    expect(isBridgeCommand("/context")).toBe(true);
  });

  it("returns context_status result with turn count", () => {
    const db = openDb(":memory:");
    db.addConvTurn("chat:1", "user", "hello");
    const result = handleCommand("claude", "/context", { db, chatId: "chat:1", config: stubConfig });
    expect(result?.kind).toBe("message");
    expect(result?.text).toContain("1 turn");
  });

  it("nudges users to compact when stored turns are high", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 101; i++) {
      db.addConvTurn("chat:1", "user", `turn ${i}`);
    }
    const result = handleCommand("claude", "/context", { db, chatId: "chat:1", config: stubConfig });
    expect(result?.kind).toBe("message");
    expect(result?.text).toContain("High turn count - consider /compact");
  });

  it("shows when compact is already in progress", () => {
    const db = openDb(":memory:");
    db.setSetting("compact_in_progress:chat:1", "2026-06-27T13:35:20.000Z");

    const result = handleCommand("claude", "/context", { db, chatId: "chat:1", config: stubConfig });

    expect(result?.kind).toBe("message");
    expect(result?.text).toContain("Compact: in progress since 2026-06-27T13:35:20.000Z");
  });
});
