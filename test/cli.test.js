import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { getCliWorkingDir } from "../src/bridge.js";

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
