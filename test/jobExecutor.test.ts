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

  it("fails a job with no registered handler instead of leaving it pending", async () => {
    const job = db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: `scan:agent-bridge:4`,
      input_json: { repository: "agent-bridge" },
    });
    const notify = vi.fn();

    const result = await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: {},
      notify,
    });

    // No handler → permanent failure, loudly reported — never left
    // pending where it head-of-line blocks the whole queue.
    expect(result).toEqual({ jobId: job.id });
    const updated = db.getWorkJob(job.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toMatch(/no handler/i);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/no handler/i));
  });

  it("does not let an unhandled task type block jobs behind it", async () => {
    db.createWorkJob({
      task_type: "ops_check",
      idempotency_key: "ops:1",
    });
    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:agent-bridge:behind",
      input_json: { repository: "agent-bridge" },
    });

    const handler = vi.fn().mockResolvedValue({ summary: "ok" });
    const deps = {
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify: vi.fn(),
    };

    await executeNextJob(deps); // fails the ops_check job
    await executeNextJob(deps); // must reach the defect_scan job

    expect(handler).toHaveBeenCalledOnce();
    const jobs = db.listWorkJobs();
    expect(jobs.find(j => j.task_type === "ops_check")?.status).toBe("failed");
    expect(jobs.find(j => j.task_type === "defect_scan")?.status).toBe("completed");
  });

  it("claims only the targetJobId when provided", async () => {
    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:older:1",
    });
    const target = db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:target:1",
    });

    const handler = vi.fn().mockResolvedValue({ summary: "ok" });
    const result = await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify: vi.fn(),
      targetJobId: target.id,
    });

    expect(result?.jobId).toBe(target.id);
    expect(db.getWorkJob(target.id)?.status).toBe("completed");
    // The older job must remain untouched
    const older = db.listWorkJobs().find(j => j.idempotency_key === "scan:older:1");
    expect(older?.status).toBe("pending");
  });

  it("extends the lease while a long-running handler is in flight", async () => {
    vi.useFakeTimers();
    try {
      const job = db.createWorkJob({
        task_type: "defect_scan",
        idempotency_key: "scan:heartbeat:1",
      });

      let release!: () => void;
      const handler = vi.fn(
        () => new Promise<{ summary: string }>((res) => {
          release = () => res({ summary: "ok" });
        }),
      );

      const startMs = Date.now();
      const pending = executeNextJob({
        db,
        workerId: "test-worker",
        handlers: { defect_scan: handler },
        notify: vi.fn(),
        leaseSeconds: 10,
        heartbeatIntervalMs: 1000,
      });

      // Run past the original 10s lease while the handler is still working
      await vi.advanceTimersByTimeAsync(12_000);

      const during = db.getWorkJob(job.id)!;
      expect(during.heartbeat_at).not.toBeNull();
      // The lease must have been pushed past its original expiry
      expect(new Date(during.lease_expires_at!).getTime()).toBeGreaterThan(startMs + 10_000);
      // And the job must not be claimable by anyone else right now
      expect(db.claimNextWorkJob("rival-worker", new Date().toISOString(), 60)).toBeNull();

      release();
      await pending;
      expect(db.getWorkJob(job.id)!.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops heartbeating after the handler completes", async () => {
    vi.useFakeTimers();
    try {
      const job = db.createWorkJob({
        task_type: "defect_scan",
        idempotency_key: "scan:heartbeat:2",
      });

      const handler = vi.fn().mockResolvedValue({ summary: "ok" });
      await executeNextJob({
        db,
        workerId: "test-worker",
        handlers: { defect_scan: handler },
        notify: vi.fn(),
        leaseSeconds: 10,
        heartbeatIntervalMs: 1000,
      });

      const after = db.getWorkJob(job.id)!.heartbeat_at;
      await vi.advanceTimersByTimeAsync(5_000);
      // No further heartbeats once the job is done
      expect(db.getWorkJob(job.id)!.heartbeat_at).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls onStart with the claimed job before the handler runs", async () => {
    const job = db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:onstart:1",
    });

    const order: string[] = [];
    const handler = vi.fn(async () => {
      order.push("handler");
      return { summary: "ok" };
    });
    const onStart = vi.fn((claimed: { id: number }) => {
      order.push(`start:${claimed.id}`);
    });

    await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify: vi.fn(),
      onStart,
    });

    expect(order).toEqual([`start:${job.id}`, "handler"]);
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
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Found 2 potential issues."), expect.anything());
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

  it("passes phase='initial' and phaseData={} to a new job's handler context", async () => {
    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:phase:ctx:1",
    });

    let capturedCtx: any;
    const handler = vi.fn(async (_input: any, ctx: any) => {
      capturedCtx = ctx;
      return { summary: "ok" };
    });

    await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify: vi.fn(),
    });

    expect(capturedCtx.phase).toBe("initial");
    expect(capturedCtx.phaseData).toEqual({});
  });

  it("re-queues a job as pending when handler returns status='continue'", async () => {
    const job = db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:continue:1",
      max_attempts: 10,
    });

    const handler = vi.fn().mockResolvedValue({
      status: "continue",
      phase: "step_two",
      phaseData: { step: 2, foo: "bar" },
      summary: "Phase 1 done, continuing to step_two",
    });

    const notify = vi.fn();
    const result = await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify,
    });

    const updated = db.getWorkJob(result!.jobId);
    expect(updated?.status).toBe("pending");
    expect(updated?.phase).toBe("step_two");
    expect(JSON.parse(updated?.phase_data_json ?? "{}")).toEqual({ step: 2, foo: "bar" });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("continuing to step_two"));
  });

  it("passes accumulated phase and phaseData from a continued job back to the handler", async () => {
    const job = db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:continue:2",
      max_attempts: 10,
    });

    let runCount = 0;
    const ctxCaptures: any[] = [];
    const handler = vi.fn(async (_input: any, ctx: any) => {
      ctxCaptures.push({ phase: ctx.phase, phaseData: ctx.phaseData });
      runCount++;
      if (runCount === 1) {
        return { status: "continue", phase: "phase_b", phaseData: { x: 42 }, summary: "moving to b" };
      }
      return { summary: "done" };
    });

    const deps = {
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify: vi.fn(),
    };

    await executeNextJob(deps);
    await executeNextJob(deps);

    expect(ctxCaptures[0]).toEqual({ phase: "initial", phaseData: {} });
    expect(ctxCaptures[1]).toEqual({ phase: "phase_b", phaseData: { x: 42 } });
    expect(db.getWorkJob(job.id)?.status).toBe("completed");
  });

  it("does not mark a continued job as completed", async () => {
    const job = db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:continue:3",
      max_attempts: 10,
    });

    const handler = vi.fn().mockResolvedValue({
      status: "continue",
      phase: "next",
      phaseData: {},
      summary: "continuing",
    });

    await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      notify: vi.fn(),
    });

    const updated = db.getWorkJob(job.id);
    expect(updated?.status).not.toBe("completed");
    expect(updated?.result_json).toBeNull();
  });
});
