import { describe, it, expect } from "vitest";
import { safeExec } from "../../src/appliance/exec.js";

describe("safeExec", () => {
  it("captures stdout", async () => {
    const r = await safeExec("echo", ["hello world"]);
    expect(r.stdout.trim()).toBe("hello world");
    expect(r.code).toBe(0);
  });

  it("captures non-zero exit code without throwing", async () => {
    const r = await safeExec("sh", ["-c", "exit 42"]);
    expect(r.code).toBe(42);
  });

  it("captures stderr", async () => {
    const r = await safeExec("sh", ["-c", "echo err >&2"]);
    expect(r.stderr.trim()).toBe("err");
  });

  it("uses cwd option", async () => {
    const r = await safeExec("pwd", [], { cwd: "/tmp" });
    expect(r.stdout.trim()).toBe("/tmp");
  });

  it("throws on timeout", async () => {
    await expect(safeExec("sleep", ["10"], { timeoutMs: 100 })).rejects.toThrow("timed out");
  });
});
