import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createDefectScanHandler } from "../src/handlers/defectScan.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb() {
  const dbPath = join(tmpdir(), `defect-scan-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createDefectScanHandler", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb());
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("returns a handler function", () => {
    const handler = createDefectScanHandler({ runCli: vi.fn() });
    expect(typeof handler).toBe("function");
  });

  it("calls runCli with a defect analysis prompt containing the repository name", async () => {
    const runCli = vi.fn().mockResolvedValue("No defects found.");
    const handler = createDefectScanHandler({ runCli });

    await handler({ repository: "agent-bridge" }, { db, workerId: "test-worker" });

    expect(runCli).toHaveBeenCalledOnce();
    const [command, args] = runCli.mock.calls[0];
    const prompt: string = args[args.length - 1];
    expect(prompt).toContain("agent-bridge");
    expect(prompt.toLowerCase()).toMatch(/defect|scan|review|analys/);
  });

  it("includes typecheck and churn analysis instructions in the prompt", async () => {
    const runCli = vi.fn().mockResolvedValue("All good.");
    const handler = createDefectScanHandler({ runCli });

    await handler({ repository: "agent-bridge" }, { db, workerId: "test-worker" });

    const prompt: string = runCli.mock.calls[0][1].at(-1);
    expect(prompt).toContain("npm run typecheck");
    expect(prompt).toMatch(/churn|git log/i);
  });

  it("returns a summary from the CLI output", async () => {
    const runCli = vi.fn().mockResolvedValue(
      "DEFECT FINDINGS:\n1. Possible race condition in lock.ts\n\nOVERALL: 1 potential issue found."
    );
    const handler = createDefectScanHandler({ runCli });

    const result = await handler({ repository: "agent-bridge" }, { db, workerId: "test-worker" });

    expect(result.summary).toContain("1 potential issue");
    expect(typeof result.rawOutput).toBe("string");
  });

  it("creates proposed work_items in the DB when findings mention specific issues", async () => {
    const runCli = vi.fn().mockResolvedValue(
      `DEFECT FINDINGS:
- Title: Race condition in lock.ts
  Impact: High
  Confidence: high
  Evidence: lock is released without checking owner

- Title: Missing error handler in engine.ts
  Impact: Medium
  Confidence: medium
  Evidence: uncaught rejection path

OVERALL: 2 potential issues found.`
    );

    const handler = createDefectScanHandler({ runCli });

    await handler({ repository: "agent-bridge" }, { db, workerId: "test-worker" });

    const items = db.listWorkItems();
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some(i => i.title.toLowerCase().includes("race condition"))).toBe(true);
  });

  it("handles empty CLI output gracefully", async () => {
    const runCli = vi.fn().mockResolvedValue("");
    const handler = createDefectScanHandler({ runCli });

    const result = await handler({ repository: "agent-bridge" }, { db, workerId: "test-worker" });

    expect(result.summary).toBeTruthy();
    expect(db.listWorkItems()).toHaveLength(0);
  });

  it("propagates CLI errors as thrown exceptions", async () => {
    const runCli = vi.fn().mockRejectedValue(new Error("CLI process killed"));
    const handler = createDefectScanHandler({ runCli });

    await expect(
      handler({ repository: "agent-bridge" }, { db, workerId: "test-worker" })
    ).rejects.toThrow("CLI process killed");
  });

  it("uses 'claude' CLI command by default", async () => {
    const runCli = vi.fn().mockResolvedValue("Done.");
    const handler = createDefectScanHandler({ runCli });

    await handler({ repository: "agent-bridge" }, { db, workerId: "test-worker" });

    const command: string = runCli.mock.calls[0][0];
    expect(command).toBe("claude");
  });

  it("accepts a custom CLI command override", async () => {
    const runCli = vi.fn().mockResolvedValue("Done.");
    const handler = createDefectScanHandler({ runCli, command: "codex" });

    await handler({ repository: "agent-bridge" }, { db, workerId: "test-worker" });

    const command: string = runCli.mock.calls[0][0];
    expect(command).toBe("codex");
  });

  it("runs the CLI inside the resolved repository path", async () => {
    const runCli = vi.fn().mockResolvedValue("OVERALL: 0 potential issues found.");
    const resolveRepoPath = vi.fn().mockReturnValue("/repos/content-crawler");
    const handler = createDefectScanHandler({ runCli, resolveRepoPath });

    await handler({ repository: "content-crawler" }, { db, workerId: "test-worker" });

    expect(resolveRepoPath).toHaveBeenCalledWith("content-crawler");
    expect(runCli.mock.calls[0][2]).toBe("/repos/content-crawler");
  });

  it("fails with a clear error when the repository cannot be resolved", async () => {
    const runCli = vi.fn().mockResolvedValue("Done.");
    const resolveRepoPath = vi.fn().mockReturnValue(null);
    const handler = createDefectScanHandler({ runCli, resolveRepoPath });

    await expect(
      handler({ repository: "ghost-repo" }, { db, workerId: "test-worker" })
    ).rejects.toThrow(/ghost-repo|no local checkout/i);
    // Never scan the wrong directory while claiming to scan the target
    expect(runCli).not.toHaveBeenCalled();
  });
});
