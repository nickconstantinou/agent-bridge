import { describe, expect, it, vi } from "vitest";
import { runCli, runCliAsync } from "../src/cli.js";
import { getCliWorkingDir } from "../src/bridge.js";

describe("runCliAsync", () => {
  it("calls onProgress callback with stdout chunks", async () => {
    const progressCalls = [];
    
    await runCliAsync("bash", ["-lc", "echo line1; echo line2; echo line3"], getCliWorkingDir(), {
      onProgress: (text) => progressCalls.push(text),
    });
    
    expect(progressCalls.length).toBeGreaterThan(0);
  });

  it("calls onCancel with kill function", async () => {
    let killFn = null;
    const cancelCalled = { value: false };
    
    const pr = runCliAsync("bash", ["-lc", "sleep 30"], getCliWorkingDir(), {
      timeoutMs: 5000,
      onCancel: (fn) => { killFn = fn; },
    });
    
    // Give it a moment to start
    await new Promise(r => setTimeout(r, 20));
    expect(killFn).not.toBeNull();
    
    // Cancel the process
    if (killFn) killFn();
    
    await expect(pr).rejects.toThrow();
    cancelCalled.value = true;
    expect(cancelCalled.value).toBe(true);
  });

  it("resolves with text on success", async () => {
    const result = await runCliAsync("bash", ["-lc", "echo hello world"], getCliWorkingDir());
    
    expect(result.text).toContain("hello world");
  });

  it("rejects with error on CLI failure", async () => {
    await expect(
      runCliAsync("bash", ["-lc", "exit 1"], getCliWorkingDir()),
    ).rejects.toThrow();
  });
});

describe("cli timeout handling", () => {
  it("rejects on timeout for a hanging process", async () => {
    const start = Date.now();
    await expect(
      runCli("bash", ["-lc", "trap '' TERM; sleep 5"], getCliWorkingDir(), { timeoutMs: 50, killGraceMs: 25 }),
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("resets the idle timeout when the process keeps emitting output", async () => {
    const start = Date.now();
    const result = await runCli(
      "bash",
      ["-lc", "for i in 1 2 3; do echo tick-$i; sleep 0.03; done"],
      getCliWorkingDir(),
      { timeoutMs: 1000, idleTimeoutMs: 100, killGraceMs: 25 },
    );

    expect(result).toContain("tick-1");
    expect(result).toContain("tick-3");
    expect(Date.now() - start).toBeGreaterThanOrEqual(60);
  });
});
