/**
 * PURPOSE: PR merge gate — inline keyboard builder and callback handler for
 * merge_pr approval flow. Wires the [Merge PR] and [Close PR] buttons shown
 * after a draft PR is opened by the pr_lifecycle handler.
 * NEIGHBORS: src/workCallbacks.ts, src/handlers/prLifecycle.ts, src/db.ts
 */

import type { BridgeDb, GithubLink } from "./db.js";
import { createWorkspaceCleanup, defaultWorkspaceBaseDir } from "./workspace.js";
import { join } from "node:path";

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
  cleanupWorkspace?: (dir: string) => void;
}

/** Conclusions/states that mean a check did not succeed. */
const FAILING_CHECK_VALUES = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING_CHECK_STATES = new Set(["PENDING", "EXPECTED", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED"]);

interface PrViewState {
  headRefOid?: string;
  isDraft?: boolean;
  state?: string;
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

function cleanupWorkItemWorkspace(ctx: PrMergeCallbackCtx, workItemId: number): void {
  const cleanup = ctx.cleanupWorkspace ?? createWorkspaceCleanup();
  cleanup(join(defaultWorkspaceBaseDir(), `work-${workItemId}`));
}

function parsePrUrl(prUrl: string | undefined): { repository?: string; pr_number?: number } {
  const match = prUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (!match) return {};
  return { repository: match[1], pr_number: Number(match[2]) };
}

async function resolveTerminalPrIfNeeded(
  ctx: PrMergeCallbackCtx,
  actionId: number,
  payload: { pr_url?: string; pr_number?: number; repository?: string },
  approval: { id: number },
): Promise<boolean> {
  const { db, runCommand, answerCbq, editMessage } = ctx;
  const parsedUrl = parsePrUrl(payload.pr_url);
  const repo = payload.repository ?? parsedUrl.repository ?? "";
  const prNumber = payload.pr_number ?? parsedUrl.pr_number;
  const prRef: string[] = prNumber != null ? [String(prNumber)] : payload.pr_url ? [payload.pr_url] : [];
  if (prRef.length === 0) return false;

  let state = "";
  try {
    const raw = await runCommand("gh", ["pr", "view", ...prRef, ...(repo ? ["--repo", repo] : []), "--json", "state"]);
    state = String((JSON.parse(raw) as { state?: string }).state ?? "").toLowerCase();
  } catch {
    return false;
  }

  if (state !== "merged" && state !== "closed") return false;

  if (state === "merged") {
    db.resolveApproval(approval.id, "approved", ctx.userId ?? "github-reconcile");
    db.updateWorkItemStatus(actionId, "resolved");
    if (prNumber != null) {
      const link = db.raw.prepare("SELECT id FROM github_links WHERE work_item_id = ? AND pr_number = ?")
        .get(actionId, prNumber) as { id: number } | undefined;
      if (link) db.updatePrState(link.id, "merged");
    }
    cleanupWorkItemWorkspace(ctx, actionId);
    await answerCbq();
    await editMessage(`PR already merged on GitHub. Work item #${actionId} resolved.`);
    return true;
  }

  db.resolveApproval(approval.id, "rejected", ctx.userId ?? "github-reconcile");
  db.updateWorkItemStatus(actionId, "closed");
  if (prNumber != null) {
    const link = db.raw.prepare("SELECT id FROM github_links WHERE work_item_id = ? AND pr_number = ?")
      .get(actionId, prNumber) as { id: number } | undefined;
    if (link) db.updatePrState(link.id, "closed");
  }
  cleanupWorkItemWorkspace(ctx, actionId);
  await answerCbq();
  await editMessage(`PR already closed on GitHub. Work item #${actionId} closed.`);
  return true;
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

  const parsedPrUrl = parsePrUrl(payload.pr_url);
  const repo = payload.repository ?? parsedPrUrl.repository ?? "";
  const prNumber = payload.pr_number ?? parsedPrUrl.pr_number;
  const prRef: string[] = prNumber != null
    ? [String(prNumber)]
    : payload.pr_url ? [payload.pr_url] : [];
  const repoFlag = repo ? ["--repo", repo] : [];

  if (await resolveTerminalPrIfNeeded(ctx, action.id, payload, approval)) return;

  if (action.type === "wi_mrgpr") {
    if (prNumber != null) {
      const link = db.raw.prepare(
        "SELECT pr_state FROM github_links WHERE work_item_id = ? AND pr_number = ?"
      ).get(action.id, prNumber) as { pr_state: string } | undefined;
      if (!link || link.pr_state !== "ready_to_merge") {
        await answerCbq();
        await editMessage(
          `Merge blocked: PR has not been marked ready_to_merge by pr_watch. Wait for CI watch to pass and refresh the merge approval.`,
          buildPrMergeKeyboard(action.id),
        );
        return;
      }
    }

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

    // Execute squash merge (without --delete-branch so branch deletion errors don't mask merge success)
    const mergeArgs = ["pr", "merge", "--squash", ...repoFlag, ...prRef];
    let mergeSucceeded = false;
    try {
      await runCommand("gh", mergeArgs);
      mergeSucceeded = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already merged/i.test(msg)) {
        mergeSucceeded = true;
      } else {
        const branch = payload.branch_name || `agent/work-${action.id}`;
        const sha = view.headRefOid || payload.head_sha || "unknown";
        enqueueMergeFixJob(db, action.id, prNumber || 0, repo, branch, sha);
        await answerCbq();
        await editMessage(
          `Merge failed: ${msg}. Enqueued a fix job to resolve issues.`,
          keyboard,
        );
        return;
      }
    }

    // Delete branch separately — non-fatal if already gone
    const branchName = payload.branch_name;
    if (branchName && repo) {
      try {
        await runCommand("gh", ["api", `repos/${repo}/git/refs/heads/${branchName}`, "-X", "DELETE"]);
      } catch { /* branch deletion is best-effort */ }
    }

    db.resolveApproval(approval.id, "approved", ctx.userId ?? "user");
    db.updateWorkItemStatus(action.id, "resolved");
    if (prNumber != null) {
      const mergedLink = db.raw.prepare(
        "SELECT id FROM github_links WHERE work_item_id = ? AND pr_number = ?"
      ).get(action.id, prNumber) as { id: number } | undefined;
      if (mergedLink) db.updatePrState(mergedLink.id, "merged");
    }
    cleanupWorkItemWorkspace(ctx, action.id);

    await answerCbq();
    await editMessage(`PR merged and branch deleted. Work item #${action.id} resolved.`);
  } else {
    // Close PR without merging
    const closeArgs = ["pr", "close", ...repoFlag];
    if (prNumber != null) {
      closeArgs.push(String(prNumber));
    } else if (payload.pr_url) {
      closeArgs.push(payload.pr_url);
    }

    let closeSucceeded = false;
    try {
      await runCommand("gh", closeArgs);
      closeSucceeded = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already closed/i.test(msg)) {
        closeSucceeded = true;
      } else {
        await answerCbq();
        await editMessage(`PR close failed: ${msg}. Approval kept pending.`);
        return;
      }
    }

    if (closeSucceeded) {
      // Delete branch separately — non-fatal if already gone
      const branchName = payload.branch_name;
      if (branchName && repo) {
        try {
          await runCommand("gh", ["api", `repos/${repo}/git/refs/heads/${branchName}`, "-X", "DELETE"]);
        } catch { /* branch deletion is best-effort */ }
      }

      // Mark the github_links row closed so listOpenAgentPrs() stops returning it
      if (prNumber != null) {
        const closedLink = db.raw.prepare(
          "SELECT id FROM github_links WHERE work_item_id = ? AND pr_number = ?"
        ).get(action.id, prNumber) as { id: number } | undefined;
        if (closedLink) db.updatePrState(closedLink.id, "closed");
      }

      db.resolveApproval(approval.id, "rejected", ctx.userId ?? "user");
      db.updateWorkItemStatus(action.id, "closed");
      cleanupWorkItemWorkspace(ctx, action.id);

      await answerCbq();
      await editMessage(`PR closed. Work item #${action.id} closed.`);
    }
  }
}
