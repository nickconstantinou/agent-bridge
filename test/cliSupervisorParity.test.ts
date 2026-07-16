import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, runCliAsync } from "../src/cli.js";

// Issue #135 Phase 2 — CLI supervisor consolidation.
// These tests lock in behavioural parity between the sync (runCli) and async
// (runCliAsync) execution paths before they are unified onto one internal
// runner, per the implementation plan's "add race and parity tests before
// implementation" requirement.

describe("sync/async timeout settlement parity", () => {
  it("does not settle the promise before the killed child has actually exited", async () => {
    // A script that ignores the first SIGTERM signal-death path and instead
    // takes a moment to clean up before exiting, writing a marker file right
    // before it does. If the runner settles its promise before the child is
    // confirmed dead, the marker file will not exist yet at settlement time.
    const tempDir = mkdtempSync(join(tmpdir(), "agent-bridge-timeout-parity-"));
    const markerPath = join(tempDir, "exited-after-term");
    const scriptPath = join(tempDir, "slow-to-die.sh");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        `trap 'sleep 0.2; touch "${markerPath}"; exit 0' TERM`,
        "sleep 30 &",
        "wait",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      await expect(
        runCli(scriptPath, [], tempDir, { timeoutMs: 100, killGraceMs: 2_000 }),
      ).rejects.toThrow(/hard timeout/i);
      expect(existsSync(markerPath), "runCli settled before the killed child actually exited").toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 5_000);

  it("runCliAsync also does not settle before the killed child has actually exited", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "agent-bridge-timeout-parity-async-"));
    const markerPath = join(tempDir, "exited-after-term");
    const scriptPath = join(tempDir, "slow-to-die.sh");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        `trap 'sleep 0.2; touch "${markerPath}"; exit 0' TERM`,
        "sleep 30 &",
        "wait",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      await expect(
        runCliAsync(scriptPath, [], tempDir, { timeoutMs: 100, killGraceMs: 2_000 }),
      ).rejects.toThrow(/hard timeout/i);
      expect(existsSync(markerPath), "runCliAsync settled before the killed child actually exited").toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 5_000);
});
