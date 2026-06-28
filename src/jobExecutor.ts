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
  /** Current job phase — 'initial' for new jobs. */
  phase: string;
  /** Opaque state blob written by the last continue result. */
  phaseData: object;
}

export interface JobHandlerResult {
  /**
   * 'continue' re-queues this job as pending with a new phase/phaseData checkpoint.
   * Omitting status (or 'completed') transitions the job to completed.
   */
  status?: 'completed' | 'continue';
  summary: string;
  /** Required when status='continue'. */
  phase?: string;
  /** Required when status='continue'. */
  phaseData?: object;
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
const MAX_REPAIR_CONTEXT_CHARS = 12_000;

function getTddWorkItemId(
  job: { work_item_id: number | null },
  input: JobHandlerInput,
): number | null {
  return typeof input.work_item_id === "number" ? input.work_item_id : job.work_item_id;
}

function canEnqueueTddRepairJob(
  job: { task_type: string; work_item_id: number | null },
  input: JobHandlerInput,
): boolean {
  if (job.task_type !== "tdd_implementation") return false;
  if (input.repair_of_job_id || input.repair_context || input.ci_fix) return false;
  return typeof getTddWorkItemId(job, input) === "number";
}

function classifyTddOrchestrationFailure(message: string): "timeout" | "capacity" | "transient" | null {
  if (/\b(?:hard|idle|cli|print)?\s*timeout\b|timed out|ETIMEDOUT/i.test(message)) return "timeout";
  if (/capacity|RESOURCE_EXHAUSTED|rate limit|rate-limit|429|quota/i.test(message)) return "capacity";
  if (/ECONNRESET|ECONNREFUSED|EPIPE|temporar(?:y|ily)|transient|unavailable|socket hang up|network/i.test(message)) {
    return "transient";
  }
  return null;
}

function tddNeedsHumanSummary(jobId: number, reason: "timeout" | "capacity" | "transient"): string {
  return `TDD implementation job #${jobId} needs human attention: orchestration ${reason}; auto-repair is not available.`;
}

function enqueueTddRepairJobIfNeeded(
  db: BridgeDb,
  job: { id: number; task_type: string; work_item_id: number | null; input_json: string },
  input: JobHandlerInput,
  message: string,
): { id: number } | null {
  if (!canEnqueueTddRepairJob(job, input)) return null;
  const updated = db.getWorkJob(job.id);
  if (!updated || updated.status !== "failed") return null;
  const workItemId = getTddWorkItemId(job, input);
  if (workItemId == null) return null;

  return db.createWorkJob({
    task_type: "tdd_implementation",
    idempotency_key: `tdd_repair:${job.id}`,
    work_item_id: workItemId,
    input_json: {
      ...input,
      work_item_id: workItemId,
      repair_of_job_id: job.id,
      repair_context: message.slice(-MAX_REPAIR_CONTEXT_CHARS),
    },
    max_attempts: 1,
  });
}

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

  const phase = (job as any).phase ?? 'initial';
  let phaseData: object = {};
  try {
    if ((job as any).phase_data_json) {
      phaseData = JSON.parse((job as any).phase_data_json);
    }
  } catch { /* non-fatal */ }

  // Keep the lease alive while the handler runs so a long job is never
  // reclaimed (and duplicated) by another worker or a later tick.
  const heartbeat = setInterval(() => {
    try {
      db.heartbeatWorkJob(job.id, workerId, new Date().toISOString(), leaseSeconds);
    } catch { /* non-fatal */ }
  }, heartbeatIntervalMs);

  try {
    const result = await handler(input, { db, workerId, phase, phaseData });
    if (result.status === 'continue') {
      db.continueWorkJob(job.id, result.phase ?? 'initial', result.phaseData ?? {}, workerId);
      if (result.summary) await notify(result.summary);
    } else {
      db.completeWorkJob(job.id, result, workerId);
      await notify(result.summary, result);
    }
    return { jobId: job.id, handlerResult: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const tddOrchestrationFailure = classifyTddOrchestrationFailure(message);
    if (tddOrchestrationFailure && job.task_type === "tdd_implementation" && !canEnqueueTddRepairJob(job, input)) {
      const summary = tddNeedsHumanSummary(job.id, tddOrchestrationFailure);
      db.failWorkJobPermanently(job.id, summary, workerId);
      await notify(summary);
      return { jobId: job.id };
    }
    if (err instanceof PermanentJobFailureError) {
      db.failWorkJobPermanently(job.id, message, workerId);
    } else {
      db.failWorkJob(job.id, message, workerId);
    }
    await notify(`Job #${job.id} failed: ${message}`);
    if (!(err instanceof PermanentJobFailureError)) {
      const repair = enqueueTddRepairJobIfNeeded(db, job, input, message);
      if (repair) await notify(`Repair job #${repair.id} queued for failed job #${job.id}.`);
    }
    return { jobId: job.id };
  } finally {
    clearInterval(heartbeat);
  }
}
