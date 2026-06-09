/**
 * PURPOSE: Claim and execute the next pending work_job.
 * Each call claims one job, dispatches to the registered handler, and transitions
 * the job to completed or failed. Returns null when nothing is available or claimable.
 * NEIGHBORS: src/db.ts, src/index-worker.ts
 */

import type { BridgeDb } from "./db.js";

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
}

export interface ExecuteNextJobResult {
  jobId: number;
  handlerResult?: JobHandlerResult;
}

const DEFAULT_LEASE_SECONDS = 300;

export async function executeNextJob(
  deps: ExecuteNextJobDeps,
): Promise<ExecuteNextJobResult | null> {
  const { db, workerId, handlers, notify, leaseSeconds = DEFAULT_LEASE_SECONDS } = deps;

  // Peek at the next claimable job without claiming it
  const now = new Date().toISOString();
  const candidate = db.raw.prepare(
    `SELECT * FROM work_jobs
     WHERE status = 'pending'
        OR (status IN ('leased','running') AND datetime(lease_expires_at) <= datetime('now'))
     ORDER BY created_at ASC
     LIMIT 1`,
  ).get() as { id: number; task_type: string } | undefined;

  if (!candidate) return null;

  // No handler registered — leave this job pending and return
  const handler = handlers[candidate.task_type];
  if (!handler) return null;

  // Claim the job
  const job = db.claimNextWorkJob(workerId, now, leaseSeconds);
  if (!job) return null;

  db.markWorkJobRunning(job.id, workerId);

  let input: JobHandlerInput = {};
  try {
    input = job.input_json ? JSON.parse(job.input_json) : {};
  } catch {
    // non-fatal — proceed with empty input
  }

  try {
    const result = await handler(input, { db, workerId });
    db.completeWorkJob(job.id, result, workerId);
    await notify(result.summary, result);
    return { jobId: job.id, handlerResult: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.failWorkJob(job.id, message, workerId);
    await notify(`Job #${job.id} failed: ${message}`);
    return { jobId: job.id };
  }
}
