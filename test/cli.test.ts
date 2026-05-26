import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { runCli, runCliAsync, abortCliProcess, shutdownCliProcesses, isCapacityExhaustedError, getNextFallbackModel, toAntigravityModelLabel, setAntigravityModel, parseCliResult } from "../src/cli.js";
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

  it("extracts RESOURCE_EXHAUSTED log errors and identifies capacity exhaustion", () => {
    const logErr = "E0526 15:21:41.395478 3605783 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): Individual quota reached.";
    
    let caught: any;
    try {
      parseCliResult({ bot: "antigravity", stdout: "", logContent: logErr });
    } catch (err: any) {
      caught = err;
    }
    
    expect(caught).toBeDefined();
    expect(caught.message).toContain("RESOURCE_EXHAUSTED");
    expect(isCapacityExhaustedError(caught)).toBe(true);
  });
});
