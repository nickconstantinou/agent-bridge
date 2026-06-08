/**
 * PURPOSE: Background polling loop that drives executeNextJob on a fixed interval.
 * Extracts notify_chat_id from job input_json and routes Telegram notifications.
 * Returns a stop() function; caller is responsible for cleanup on process exit.
 * NEIGHBORS: src/jobExecutor.ts, src/index-worker.ts
 */

import { executeNextJob, type JobHandler } from "./jobExecutor.js";
import type { BridgeDb } from "./db.js";

export interface JobExecutorLoopDeps {
  db: BridgeDb;
  workerId: string;
  handlers: Partial<Record<string, JobHandler>>;
  sendMessage: (chatId: number, text: string) => Promise<void> | void;
  intervalMs?: number;
}

export function startJobExecutorLoop(deps: JobExecutorLoopDeps): () => void {
  const { db, workerId, handlers, sendMessage, intervalMs = 10_000 } = deps;

  const handle = setInterval(() => {
    void (async () => {
      try {
        // Peek at next claimable job to get its input_json for notify routing
        const candidate = db.raw.prepare(
          `SELECT input_json FROM work_jobs
           WHERE status = 'pending'
              OR (status IN ('leased','running') AND datetime(lease_expires_at) <= datetime('now'))
           ORDER BY created_at ASC LIMIT 1`,
        ).get() as { input_json: string } | undefined;

        let notifyChatId: number | null = null;
        if (candidate) {
          try {
            const parsed = JSON.parse(candidate.input_json);
            if (typeof parsed.notify_chat_id === "number") {
              notifyChatId = parsed.notify_chat_id;
            }
          } catch { /* non-fatal */ }
        }

        const notify = notifyChatId != null
          ? (msg: string) => sendMessage(notifyChatId!, msg)
          : () => Promise.resolve();

        await executeNextJob({ db, workerId, handlers, notify });
      } catch (err) {
        console.error("[job-executor-loop] unhandled error", err);
      }
    })();
  }, intervalMs);

  return () => clearInterval(handle);
}
