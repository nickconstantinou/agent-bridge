import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { runCli, runCliAsync, abortCliProcess, shutdownCliProcesses, isCapacityExhaustedError, getNextFallbackModel, toAntigravityModelLabel, setAntigravityModel, parseCliResult, toUserMessage, buildCliInvocation } from "../src/cli.js";
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
});

describe("CLI Runner", () => {
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
    expect(() => parseCliResult({ bot: "antigravity", stdout: "" })).toThrow("empty response");
    expect(() => parseCliResult({ bot: "antigravity", stdout: "   " })).toThrow("empty response");
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

  it("codex: drops attachments and does not add -i when sessionId is set (resume path)", () => {
    const { args } = buildCliInvocation({
      ...base,
      bot: "codex",
      command: "codex",
      sessionId: "sess_abc",
      attachments: ["/tmp/img.png"],
    });
    expect(args).not.toContain("-i");
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
      expect(prompt).toContain("If you generate any files, save them to /tmp/bridge-out/42");
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
