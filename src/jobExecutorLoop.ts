/**
 * PURPOSE: Background polling loop that drives executeNextJob on a fixed interval.
 * Extracts notify_chat_id from job input_json and routes Telegram notifications.
 * Returns a stop() function; caller is responsible for cleanup on process exit.
 * NEIGHBORS: src/jobExecutor.ts, src/index-worker.ts
 */

import { executeNextJob, type JobHandler } from "./jobExecutor.js";
import { buildPrMergeKeyboard } from "./prMergeGate.js";
import type { BridgeDb } from "./db.js";

export interface JobExecutorLoopDeps {
  db: BridgeDb;
  workerId: string;
  handlers: Partial<Record<string, JobHandler>>;
  sendMessage: (chatId: number, text: string, replyMarkup?: object) => Promise<void> | void;
  intervalMs?: number;
}

export function startJobExecutorLoop(deps: JobExecutorLoopDeps): () => void {
  const { db, workerId, handlers, sendMessage, intervalMs = 10_000 } = deps;

  // Serialize ticks: a long-running job must not be joined by concurrent
  // claims from later ticks in the same process.
  let inFlight = false;

  const handle = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        // Peek at next claimable job to get its input_json for notify routing.
        // The claim below is pinned to this id so peek and claim cannot diverge.
        const candidate = db.raw.prepare(
          `SELECT id, task_type, status, input_json FROM work_jobs
           WHERE status = 'pending'
              OR (status IN ('leased','running') AND datetime(lease_expires_at) <= datetime('now'))
           ORDER BY created_at ASC, id ASC LIMIT 1`,
        ).get() as { id: number; task_type: string; status: string; input_json: string } | undefined;

        if (!candidate) return;

        let notifyChatId: number | null = null;
        let startMessage: string | null = null;
        try {
          const parsed = JSON.parse(candidate.input_json);
          if (typeof parsed.notify_chat_id === "number") {
            notifyChatId = parsed.notify_chat_id;
          }
          if (candidate.status === "pending" && typeof parsed.start_message === "string") {
            startMessage = parsed.start_message;
          }
        } catch { /* non-fatal */ }

        const notify = notifyChatId != null
          ? (msg: string, result?: import("./jobExecutor.js").JobHandlerResult) => {
              const replyMarkup = result && typeof result.work_item_id === "number"
                ? (() => {
                    // Attach merge keyboard when PR lifecycle job completes
                    if (typeof result.prUrl === "string") {
                      return buildPrMergeKeyboard(result.work_item_id as number);
                    }
                    return undefined;
                  })()
                : undefined;
              return sendMessage(notifyChatId!, msg, replyMarkup);
            }
          : () => Promise.resolve();

        // Long-running tasks (feature_plan, tdd_implementation) need a longer lease
        const LONG_RUNNING_TASKS = new Set(["feature_plan", "tdd_implementation"]);
        const leaseSeconds = LONG_RUNNING_TASKS.has(candidate.task_type) ? 1800 : 300;

        await executeNextJob({
          db,
          workerId,
          handlers,
          notify,
          leaseSeconds,
          targetJobId: candidate.id,
          onStart: async () => {
            // Sent only after a successful claim — a stuck job can never spam this
            if (notifyChatId != null && startMessage != null) {
              await sendMessage(notifyChatId, startMessage);
            }
          },
        });
      } catch (err) {
        console.error("[job-executor-loop] unhandled error", err);
      } finally {
        inFlight = false;
      }
    })();
  }, intervalMs);

  return () => clearInterval(handle);
}
