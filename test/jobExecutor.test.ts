import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { executeNextJob } from "../src/jobExecutor.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb() {
  const dbPath = join(tmpdir(), `executor-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("executeNextJob", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb());
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("returns null when there are no pending jobs", async () => {
    const result = await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: {},
      notify: vi.fn(),
    });
    expect(result).toBeNull();
  });

  it("claims and executes a pending job via the registered handler", async () => {
    const job = db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: `scan:agent-bridge:1`,
      input_json: { repository: "agent-bridge" },
    });

    const handler = vi.fn().mockResolvedValue({ summary: "No defects found." });

    const result = await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify: vi.fn(),
    });

    expect(result).not.toBeNull();
    expect(result?.jobId).toBe(job.id);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ repository: "agent-bridge" }),
      expect.objectContaining({ db, workerId: "test-worker" }),
    );
  });

  it("marks the job completed after a successful handler run", async () => {
    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: `scan:agent-bridge:2`,
      input_json: { repository: "agent-bridge" },
    });

    const handler = vi.fn().mockResolvedValue({ summary: "All clear." });

    const result = await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify: vi.fn(),
    });

    const updated = db.getWorkJob(result!.jobId);
    expect(updated?.status).toBe("completed");
    expect(updated?.result_json).toContain("All clear.");
  });

  it("marks the job failed when the handler throws", async () => {
    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: `scan:agent-bridge:3`,
      input_json: { repository: "agent-bridge" },
      max_attempts: 1,
    });

    const handler = vi.fn().mockRejectedValue(new Error("CLI timed out"));

    const result = await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify: vi.fn(),
    });

    const updated = db.getWorkJob(result!.jobId);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toContain("CLI timed out");
  });

  it("returns null and does not execute when no handler is registered for the task type", async () => {
    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: `scan:agent-bridge:4`,
      input_json: { repository: "agent-bridge" },
    });

    const result = await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: {},
      notify: vi.fn(),
    });

    // No handler → job stays pending (we don't want to silently eat it)
    expect(result).toBeNull();
    const jobs = db.listWorkJobs();
    expect(jobs[0].status).toBe("pending");
  });

  it("calls notify with a summary after a successful execution", async () => {
    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: `scan:agent-bridge:5`,
      input_json: { repository: "agent-bridge" },
    });

    const handler = vi.fn().mockResolvedValue({ summary: "Found 2 potential issues." });
    const notify = vi.fn();

    await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify,
    });

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Found 2 potential issues."));
  });

  it("calls notify with an error summary when the handler throws", async () => {
    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: `scan:agent-bridge:6`,
      input_json: { repository: "agent-bridge" },
    });

    const handler = vi.fn().mockRejectedValue(new Error("Network unreachable"));
    const notify = vi.fn();

    await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify,
    });

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Network unreachable"));
  });

  it("does not claim a job with a valid non-expired lease", async () => {
    const job = db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: `scan:agent-bridge:7`,
      input_json: { repository: "agent-bridge" },
    });
    // Manually claim with a far-future expiry so it cannot be reclaimed
    const futureExpiry = new Date(Date.now() + 3_600_000).toISOString();
    db.raw.prepare(
      `UPDATE work_jobs SET status = 'leased', lease_owner = 'other-worker', lease_expires_at = ? WHERE id = ?`
    ).run(futureExpiry, job.id);

    const handler = vi.fn();
    const result = await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify: vi.fn(),
    });

    expect(result).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });
});
