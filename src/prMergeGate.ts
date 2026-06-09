/**
 * PURPOSE: PR merge gate — inline keyboard builder and callback handler for
 * merge_pr approval flow. Wires the [Merge PR] and [Close PR] buttons shown
 * after a draft PR is opened by the pr_lifecycle handler.
 * NEIGHBORS: src/workCallbacks.ts, src/handlers/prLifecycle.ts, src/db.ts
 */

import type { BridgeDb } from "./db.js";

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

export async function handlePrMergeCallback(
  action: PrMergeCallbackAction,
  ctx: PrMergeCallbackCtx,
): Promise<void> {
  const { db, runCommand, answerCbq, editMessage } = ctx;

  const approval = db.raw.prepare(
    `SELECT * FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr' AND status = 'pending' ORDER BY id DESC LIMIT 1`,
  ).get(action.id) as { id: number; payload_json: string } | undefined;

  if (!approval) {
    throw new Error(`No pending merge_pr approval found for work item ${action.id}`);
  }

  let payload: { pr_url?: string; pr_number?: number; repository?: string } = {};
  try { payload = JSON.parse(approval.payload_json); } catch { /* non-fatal */ }

  const repo = payload.repository ?? "";
  const prNumber = payload.pr_number;

  if (action.type === "wi_mrgpr") {
    // Execute squash merge
    const mergeArgs = ["pr", "merge", "--squash", "--delete-branch"];
    if (repo) mergeArgs.push("--repo", repo);
    if (prNumber != null) {
      mergeArgs.push(String(prNumber));
    } else if (payload.pr_url) {
      mergeArgs.push(payload.pr_url);
    }

    await runCommand("gh", mergeArgs);

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
