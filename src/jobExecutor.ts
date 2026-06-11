/**
 * PURPOSE: Claim and execute the next pending work_job.
 * Each call claims one job, dispatches to the registered handler, and transitions
 * the job to completed or failed. Returns null when nothing is available or claimable.
 * NEIGHBORS: src/db.ts, src/index-worker.ts
 */

import type { BridgeDb } from "./db.js";

/** Thrown by a handler to signal that retrying this job is pointless. */
export class PermanentJobFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobFailureError";
  }
}

export type JobHandlerInput = Record<string, unknown>;

export interface JobHandlerContext {
  db: BridgeDb;
  workerId: string;
}

export interface JobHandlerResult {
  summary: string;
  [key: string]: unknown;
}

export type JobHandler = (
  input: JobHandlerInput,
  ctx: JobHandlerContext,
) => Promise<JobHandlerResult>;

export interface ExecuteNextJobDeps {
  db: BridgeDb;
  workerId: string;
  handlers: Partial<Record<string, JobHandler>>;
  notify: (message: string, result?: JobHandlerResult) => Promise<void> | void;
  leaseSeconds?: number;
  /** How often to extend the lease while the handler runs. */
  heartbeatIntervalMs?: number;
  /** Pin execution to this job id; nothing else is claimed this call. */
  targetJobId?: number;
  /** Called with the claimed job after the lease is taken, before the handler runs. */
  onStart?: (job: { id: number; task_type: string; input_json: string }) => Promise<void> | void;
}

export interface ExecuteNextJobResult {
  jobId: number;
  handlerResult?: JobHandlerResult;
}

const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

export async function executeNextJob(
  deps: ExecuteNextJobDeps,
): Promise<ExecuteNextJobResult | null> {
  const {
    db, workerId, handlers, notify,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    targetJobId, onStart,
  } = deps;

  // Claim the next job (or the pinned target) atomically
  const now = new Date().toISOString();
  const job = db.claimNextWorkJob(workerId, now, leaseSeconds, targetJobId);
  if (!job) return null;

  // No handler registered — fail loudly so it never head-of-line blocks the queue
  const handler = handlers[job.task_type];
  if (!handler) {
    const message = `No handler registered for task type: ${job.task_type}`;
    db.failWorkJobPermanently(job.id, message, workerId);
    await notify(`Job #${job.id} failed: ${message}`);
    return { jobId: job.id };
  }

  db.markWorkJobRunning(job.id, workerId);
  if (onStart) await onStart(job);

  let input: JobHandlerInput = {};
  try {
    input = job.input_json ? JSON.parse(job.input_json) : {};
  } catch {
    // non-fatal — proceed with empty input
  }

  // Keep the lease alive while the handler runs so a long job is never
  // reclaimed (and duplicated) by another worker or a later tick.
  const heartbeat = setInterval(() => {
    try {
      db.heartbeatWorkJob(job.id, workerId, new Date().toISOString(), leaseSeconds);
    } catch { /* non-fatal */ }
  }, heartbeatIntervalMs);

  try {
    const result = await handler(input, { db, workerId });
    db.completeWorkJob(job.id, result, workerId);
    await notify(result.summary, result);
    return { jobId: job.id, handlerResult: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PermanentJobFailureError) {
      db.failWorkJobPermanently(job.id, message, workerId);
    } else {
      db.failWorkJob(job.id, message, workerId);
    }
    await notify(`Job #${job.id} failed: ${message}`);
    return { jobId: job.id };
  } finally {
    clearInterval(heartbeat);
  }
}
