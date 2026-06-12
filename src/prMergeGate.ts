/**
 * PURPOSE: PR merge gate — inline keyboard builder and callback handler for
 * merge_pr approval flow. Wires the [Merge PR] and [Close PR] buttons shown
 * after a draft PR is opened by the pr_lifecycle handler.
 * NEIGHBORS: src/workCallbacks.ts, src/handlers/prLifecycle.ts, src/db.ts
 */

import type { BridgeDb, GithubLink } from "./db.js";

export type PrMergeCallbackAction =
  | { type: "wi_mrgpr"; id: number }
  | { type: "wi_clspr"; id: number };

export function parsePrMergeCallback(data: string): PrMergeCallbackAction | null {
  if (data.length > 64) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [prefix, rawId, action] = parts;
  if (prefix !== "wi") return null;
  const id = Number(rawId);
  if (!rawId || !Number.isInteger(id) || id <= 0 || String(id) !== rawId) return null;
  if (action === "mrgpr") return { type: "wi_mrgpr", id };
  if (action === "clspr") return { type: "wi_clspr", id };
  return null;
}

export function buildPrMergeKeyboard(workItemId: number): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: [[
      { text: "✅ Merge PR", callback_data: `wi:${workItemId}:mrgpr` },
      { text: "❌ Close PR", callback_data: `wi:${workItemId}:clspr` },
    ]],
  };
}

interface PrMergeCallbackCtx {
  db: BridgeDb;
  runCommand: (binary: string, args: string[]) => Promise<string>;
  answerCbq: (text?: string) => Promise<void>;
  editMessage: (text: string, replyMarkup?: object) => Promise<void>;
  chatId?: number;
  messageId?: number;
  userId?: string;
}

/** Conclusions/states that mean a check did not succeed. */
const FAILING_CHECK_VALUES = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING_CHECK_STATES = new Set(["PENDING", "EXPECTED", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED"]);

interface PrViewState {
  headRefOid?: string;
  isDraft?: boolean;
  statusCheckRollup?: Array<{ status?: string | null; conclusion?: string | null; state?: string | null }>;
}

/** Returns a human-readable blocker, or null when the rollup is mergeable. */
function findCheckBlocker(rollup: PrViewState["statusCheckRollup"]): string | null {
  for (const check of rollup ?? []) {
    const conclusion = (check.conclusion ?? check.state ?? "").toUpperCase();
    if (FAILING_CHECK_VALUES.has(conclusion)) return "CI checks are failing";
    const status = (check.status ?? "").toUpperCase();
    if (status && status !== "COMPLETED") return "CI checks have not completed";
    if (PENDING_CHECK_STATES.has(conclusion)) return "CI checks have not completed";
  }
  return null;
}

function enqueueMergeFixJob(
  db: BridgeDb,
  workItemId: number,
  prNumber: number,
  repo: string,
  branchName: string,
  headSha: string,
): void {
  const link = db.raw.prepare(
    "SELECT id FROM github_links WHERE work_item_id = ? AND pr_number = ?"
  ).get(workItemId, prNumber) as GithubLink | undefined;
  if (link) {
    db.updatePrState(link.id, "ci_failed");
  }

  const fixKey = `ci_fix:${repo}:${prNumber}:${headSha}`;
  db.createWorkJob({
    task_type: "tdd_implementation",
    idempotency_key: fixKey,
    work_item_id: workItemId,
    input_json: {
      work_item_id: workItemId,
      repository: repo,
      branch_name: branchName,
      ci_fix: true,
    },
    max_attempts: 1,
  });
}

export async function handlePrMergeCallback(
  action: PrMergeCallbackAction,
  ctx: PrMergeCallbackCtx,
): Promise<void> {
  const { db, runCommand, answerCbq, editMessage } = ctx;

  const approval = db.raw.prepare(
    `SELECT * FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr' AND status = 'pending' ORDER BY id DESC LIMIT 1`,
  ).get(action.id) as { id: number; payload_json: string } | undefined;

  if (!approval) {
    await answerCbq(`No pending merge approval for work item #${action.id} — already handled?`);
    return;
  }

  let payload: { pr_url?: string; pr_number?: number; repository?: string; head_sha?: string; branch_name?: string } = {};
  try { payload = JSON.parse(approval.payload_json); } catch { /* non-fatal */ }

  const repo = payload.repository ?? "";
  const prNumber = payload.pr_number;
  const prRef: string[] = prNumber != null
    ? [String(prNumber)]
    : payload.pr_url ? [payload.pr_url] : [];
  const repoFlag = repo ? ["--repo", repo] : [];

  if (action.type === "wi_mrgpr") {
    // Verify head SHA and CI state before merging — never merge blind
    const keyboard = buildPrMergeKeyboard(action.id);
    let view: PrViewState;
    try {
      const viewOut = await runCommand("gh", ["pr", "view", ...repoFlag, ...prRef, "--json", "headRefOid,statusCheckRollup,isDraft"]);
      view = JSON.parse(viewOut) as PrViewState;
    } catch (err) {
      await answerCbq();
      await editMessage(
        `Merge blocked: could not verify PR state (${err instanceof Error ? err.message : String(err)}). Approval kept pending.`,
        keyboard,
      );
      return;
    }

    if (payload.head_sha && view.headRefOid && view.headRefOid !== payload.head_sha) {
      await answerCbq();
      await editMessage(
        `Merge blocked: PR head has changed since approval was requested (expected ${payload.head_sha.slice(0, 12)}, found ${view.headRefOid.slice(0, 12)}). Re-review before merging.`,
        keyboard,
      );
      return;
    }

    if (view.isDraft) {
      try {
        await runCommand("gh", ["pr", "ready", ...repoFlag, ...prRef]);
      } catch (err) {
        await answerCbq();
        await editMessage(
          `Merge failed: could not mark PR as ready for review (${err instanceof Error ? err.message : String(err)}). Approval kept pending.`,
          keyboard,
        );
        return;
      }
    }

    const checkBlocker = findCheckBlocker(view.statusCheckRollup);
    if (checkBlocker) {
      const branch = payload.branch_name || `agent/work-${action.id}`;
      const sha = view.headRefOid || payload.head_sha || "unknown";
      enqueueMergeFixJob(db, action.id, prNumber || 0, repo, branch, sha);
      await answerCbq();
      await editMessage(`Merge blocked: ${checkBlocker}. Enqueued a fix job to resolve issues.`, keyboard);
      return;
    }

    // Execute squash merge
    const mergeArgs = ["pr", "merge", "--squash", "--delete-branch", ...repoFlag, ...prRef];
    try {
      await runCommand("gh", mergeArgs);
    } catch (err) {
      const branch = payload.branch_name || `agent/work-${action.id}`;
      const sha = view.headRefOid || payload.head_sha || "unknown";
      enqueueMergeFixJob(db, action.id, prNumber || 0, repo, branch, sha);
      await answerCbq();
      await editMessage(
        `Merge failed: ${err instanceof Error ? err.message : String(err)}. Enqueued a fix job to resolve issues.`,
        keyboard,
      );
      return;
    }

    db.resolveApproval(approval.id, "approved", ctx.userId ?? "user");
    db.updateWorkItemStatus(action.id, "resolved");

    await answerCbq();
    await editMessage(`PR merged and branch deleted. Work item #${action.id} resolved.`);
  } else {
    // Close PR without merging
    const closeArgs = ["pr", "close"];
    if (repo) closeArgs.push("--repo", repo);
    if (prNumber != null) {
      closeArgs.push(String(prNumber));
    } else if (payload.pr_url) {
      closeArgs.push(payload.pr_url);
    }

    await runCommand("gh", closeArgs);

    db.resolveApproval(approval.id, "rejected", ctx.userId ?? "user");
    db.updateWorkItemStatus(action.id, "closed");

    await answerCbq();
    await editMessage(`PR closed. Work item #${action.id} closed.`);
  }
}
