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
});
