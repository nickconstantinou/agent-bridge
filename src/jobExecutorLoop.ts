/**
 * PURPOSE: Background polling loop that drives executeNextJob on a fixed interval.
 * Extracts notify_chat_id from job input_json and routes Telegram notifications.
 * Returns a stop() function; caller is responsible for cleanup on process exit.
 * NEIGHBORS: src/jobExecutor.ts, src/index-worker.ts
 */

import { executeNextJob, type JobHandler } from "./jobExecutor.js";
import { buildPrMergeKeyboard } from "./prMergeGate.js";
import { buildPrApprovalPack, buildWorkItemApprovalPack, type ApprovalHtmlPack } from "./approvalHtml.js";
import type { BridgeDb } from "./db.js";

export interface JobExecutorLoopDeps {
  db: BridgeDb;
  workerId: string;
  handlers: Partial<Record<string, JobHandler>>;
  sendMessage: (chatId: number, text: string, replyMarkup?: object) => Promise<void> | void;
  sendApprovalPack?: (chatId: number, pack: ApprovalHtmlPack) => Promise<void> | void;
  intervalMs?: number;
}

export interface JobExecutorStopFn {
  (): void;
  stop: () => void;
  isIdle: () => boolean;
}

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\[[0-9;]{1,4}m/g;
const NOISY_LINE_PATTERN = /^(diff --git|@@ |[+-]\s{0,2}it\(|[+-]\s{0,2}expect\(|[+-]\s{0,2}(describe|test)\(|\s*at\s+|\s*❯\s+)/;
const MAX_WORKER_NOTIFICATION_CHARS = 1800;

export function sanitizeWorkerNotification(message: string): string {
  const clean = message.replace(ANSI_PATTERN, "").replace(/\r/g, "");
  const lines = clean.split("\n");
  const isNoisy = clean.length > MAX_WORKER_NOTIFICATION_CHARS
    || lines.some(line => NOISY_LINE_PATTERN.test(line))
    || /Test Files\s+\d+\s+failed|Tests\s+\d+\s+failed|FAIL\s+test\//.test(clean);

  if (!isNoisy) return clean;

  const headline = lines.find(line => line.trim().length > 0)?.trim() || "Worker job output suppressed";
  const testFiles = lines.find(line => /Test Files\s+/.test(line))?.trim();
  const tests = lines.find(line => /Tests\s+/.test(line))?.trim();
  const failure = lines.find(line => /^FAIL\s+/.test(line))?.trim();
  const details = [failure, testFiles, tests].filter(Boolean);

  return [
    headline,
    ...details,
    "",
    "Output suppressed: verbose logs/test output stored in worker DB and service journal.",
  ].join("\n").slice(0, MAX_WORKER_NOTIFICATION_CHARS);
}

export function startJobExecutorLoop(deps: JobExecutorLoopDeps): JobExecutorStopFn {
  const { db, workerId, handlers, sendMessage, sendApprovalPack, intervalMs = 10_000 } = deps;

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
          ? async (msg: string, result?: import("./jobExecutor.js").JobHandlerResult) => {
              const replyMarkup = result && typeof result.work_item_id === "number"
                ? (() => {
                    // Attach merge keyboard when PR lifecycle job completes
                    if (typeof result.prUrl === "string") {
                      return buildPrMergeKeyboard(result.work_item_id as number);
                    }
                    return undefined;
                  })()
                : undefined;
              if (result && sendApprovalPack) {
                const packs: ApprovalHtmlPack[] = [];
                const itemIds = Array.isArray(result.work_item_ids)
                  ? result.work_item_ids.filter((id): id is number => typeof id === "number")
                  : typeof result.work_item_id === "number" ? [result.work_item_id] : [];
                for (const id of itemIds) {
                  const item = db.getWorkItem(id);
                  if (item) packs.push(buildWorkItemApprovalPack(db, item));
                }
                const prItemIds = Array.isArray(result.pr_approval_work_item_ids)
                  ? result.pr_approval_work_item_ids.filter((id): id is number => typeof id === "number")
                  : [];
                for (const id of prItemIds) {
                  const pack = buildPrApprovalPack(db, id);
                  if (pack) packs.push(pack);
                }
                for (const pack of packs) {
                  try {
                    await sendApprovalPack(notifyChatId!, pack);
                  } catch (err) {
                    console.warn("[job-executor-loop] approval pack send failed", err);
                  }
                }
              }
              return sendMessage(notifyChatId!, sanitizeWorkerNotification(msg), replyMarkup);
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
              await sendMessage(notifyChatId, sanitizeWorkerNotification(startMessage));
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

  const stopFn = () => clearInterval(handle);
  (stopFn as any).stop = stopFn;
  (stopFn as any).isIdle = () => !inFlight;
  return stopFn as unknown as JobExecutorStopFn;
}
