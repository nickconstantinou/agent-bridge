import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { executeNextJob } from "../src/jobExecutor.js";
import { createOrchestratedTaskHandler } from "../src/handlers/orchestratedTask.js";
import { WORKER_BLOCKED_RESULT_MARKER } from "../src/workerBlockedResult.js";

const dbPaths: string[] = [];
function makeDb() {
  const dbPath = join(tmpdir(), `advisor-debug-lifecycle-${Date.now()}-${Math.random()}.sqlite`);
  dbPaths.push(dbPath);
  return openDb(dbPath);
}

afterEach(() => {
  for (const path of dbPaths.splice(0)) {
    try { rmSync(path); } catch { /* already removed */ }
  }
});

function blockedOutput(): string {
  return `${WORKER_BLOCKED_RESULT_MARKER} ${JSON.stringify({
    status: "BLOCKED",
    reason: "NEEDS_ADVISOR",
    hypothesis: "The parser owner is unclear",
    attempted_steps: ["Read the parser", "Ran the focused test"],
    failing_evidence: "expected accepted, received rejected",
    relevant_files: ["src/parser.ts"],
    decision_needed: "Identify the authoritative parser",
  })}`;
}

describe("advisor debug degraded lifecycle", () => {
  it("returns an explicit human-needed result when the optional advisor fails", async () => {
    const db = makeDb();
    const item = db.createWorkItem({
      kind: "feature",
      source: "telegram",
      repository: "owner/repo",
      title: "Fix parser ownership",
      created_by: "worker",
    });
    const runCli = vi.fn().mockResolvedValue(blockedOutput());
    const runGit = vi.fn().mockImplementation((args: string[]) => args[0] === "diff" ? "src/parser.ts\n" : "");
    const advisorDebugCheckpoint = vi.fn().mockRejectedValue(new Error("advisor unavailable"));

    try {
      const result = await createOrchestratedTaskHandler({
        runCli,
        runGit,
        runTests: vi.fn().mockResolvedValue({ ok: true, output: "ok" }),
        advisorDebugCheckpoint,
      })(
        { work_item_id: item.id },
        {
          db,
          workerId: "worker",
          phase: "executing",
          phaseData: {
            workItemId: item.id,
            repoPath: "/tmp/repo",
            branchName: `agent/work-${item.id}`,
            plan: "Use one parser",
          },
        },
      );

      expect(result).toMatchObject({ needsHuman: true, blockedResult: { reason: "NEEDS_ADVISOR" } });
      expect(result.summary).toMatch(/needs human attention/i);
      expect(runCli).toHaveBeenCalledTimes(1);
      expect(runGit).not.toHaveBeenCalledWith(["add", "-A"], expect.anything());
    } finally {
      db.close();
    }
  });

  it("does not claim or execute the checkpointed retry after cancellation", async () => {
    const db = makeDb();
    const job = db.createWorkJob({
      task_type: "orchestrated_task",
      idempotency_key: "orchestrated:cancel-before-retry",
      max_attempts: 5,
    });
    const handler = vi.fn().mockResolvedValue({
      status: "continue",
      phase: "executing_retry",
      phaseData: { debugAttempted: true },
      summary: "one retry queued",
    });
    const deps = {
      db,
      workerId: "worker",
      handlers: { orchestrated_task: handler },
      notify: vi.fn(),
    };

    try {
      await executeNextJob(deps);
      expect(db.getWorkJob(job.id)).toMatchObject({ status: "pending", phase: "executing_retry" });

      db.cancelWorkJob(job.id, "user cancelled before advisor retry");
      const second = await executeNextJob(deps);

      expect(second).toBeNull();
      expect(db.getWorkJob(job.id)?.status).toBe("cancelled");
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("completes a thrown executing_retry as human-needed and never claims it again", async () => {
    const db = makeDb();
    const item = db.createWorkItem({
      kind: "feature",
      source: "telegram",
      repository: "owner/repo",
      title: "Fix parser ownership",
      created_by: "worker",
    });
    const job = db.createWorkJob({
      task_type: "orchestrated_task",
      idempotency_key: "orchestrated:failed-bounded-retry",
      work_item_id: item.id,
      input_json: { work_item_id: item.id },
      max_attempts: 5,
    });
    const seeded = db.claimNextWorkJob("seed", new Date().toISOString(), 300, job.id);
    expect(seeded).not.toBeNull();
    db.markWorkJobRunning(job.id, "seed");
    db.continueWorkJob(job.id, "executing_retry", {
      workItemId: item.id,
      repoPath: "/tmp/repo",
      branchName: `agent/work-${item.id}`,
      plan: "Use one parser",
      debugAttempted: true,
      blockedResult: {
        status: "BLOCKED",
        reason: "NEEDS_ADVISOR",
        hypothesis: "ownership",
        attemptedSteps: ["read"],
        failingEvidence: "failure",
        relevantFiles: ["src/parser.ts"],
        decisionNeeded: "owner",
      },
      advisorDebug: {
        verdict: "retry",
        advice: "Use the canonical parser",
        evidenceIds: ["ev_0123456789abcdef"],
        verificationSteps: ["Run parser tests"],
        confidence: "medium",
      },
    }, "seed");

    const runCli = vi.fn().mockRejectedValue(new Error("executor transport failed"));
    const handler = createOrchestratedTaskHandler({
      runCli,
      runGit: vi.fn(),
      runTests: vi.fn().mockResolvedValue({ ok: true, output: "ok" }),
    });
    const deps = {
      db,
      workerId: "worker",
      handlers: { orchestrated_task: handler },
      notify: vi.fn(),
      targetJobId: job.id,
    };

    try {
      const first = await executeNextJob(deps);
      expect(first?.handlerResult).toMatchObject({ needsHuman: true, retryFailure: "executor transport failed" });
      expect(db.getWorkJob(job.id)).toMatchObject({ status: "completed", phase: "executing_retry", max_attempts: 5 });

      const second = await executeNextJob(deps);
      expect(second).toBeNull();
      expect(runCli).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
