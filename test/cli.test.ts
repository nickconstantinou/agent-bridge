import { describe, expect, it, vi } from "vitest";
import { runCli, runCliAsync, isCapacityExhaustedError, getGeminiFallbackModel } from "../src/cli.js";
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

  it("supports cancellation", async () => {
    let killFn: (() => void) | undefined;
    const p = runCliAsync("sleep", ["10"], process.cwd(), {
      onCancel: (k) => { killFn = k; },
    });

    if (killFn) (killFn as () => void)();
    await expect(p).rejects.toThrow();
  });
});

describe("gemini model fallback", () => {
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

  it("returns next model in fallback chain", () => {
    expect(getGeminiFallbackModel("gemini-2.5-flash")).toBe("gemini-2.5-flash-lite");
  });

  it("returns null at last fallback model", () => {
    expect(getGeminiFallbackModel("gemini-2.5-flash-lite")).toBeNull();
  });

  it("falls back to lite for unknown or null models", () => {
    expect(getGeminiFallbackModel(null)).toBe("gemini-2.5-flash-lite");
    expect(getGeminiFallbackModel("gemini-3-flash-preview")).toBe("gemini-2.5-flash-lite");
  });
});
