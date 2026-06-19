/**
 * PURPOSE: Compact Telegram callback data parser and builder for autonomous agent bridge jobs/work items.
 * Grammar:
 *   wi:<id>:view
 *   wi:<id>:appv
 *   wi:<id>:clse
 *   wi:<id>:mrgpr
 *   wi:<id>:clspr
 *   job:<id>:cncl
 *   ap:<id>:yes
 *   ap:<id>:no
 */

import { parsePrMergeCallback, handlePrMergeCallback } from "./prMergeGate.js";
import { createRunCommand } from "./runCommandAsync.js";
import { toTelegramEntitiesText } from "./render.js";
import type { WorkJob } from "./db.js";

/** Edit a message converting bold/code markdown markers to native Telegram entities. */
function editWithEntities(
  client: any,
  params: { chat_id: number; message_id: number; text: string; reply_markup?: object },
): Promise<unknown> {
  const ep = toTelegramEntitiesText(params.text);
  return client.editMessageText({
    ...params,
    text: ep.text,
    ...(ep.entities.length > 0 ? { entities: ep.entities } : {}),
  });
}

export type WorkCallbackAction =
  | { type: "wi_view"; id: number }
  | { type: "wi_appv"; id: number }
  | { type: "wi_clse"; id: number }
  | { type: "job_cncl"; id: number }
  | { type: "ap_yes"; id: number }
  | { type: "ap_no"; id: number }
  | { type: "pr_hold"; id: number }
  | { type: "pr_rels"; id: number }
  | { type: "pr_rfsh"; id: number }
  | { type: "pr_clse"; id: number };

export function parseWorkCallback(data: string): WorkCallbackAction | null {
  if (data.length > 64) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [prefix, rawId, action] = parts;
  const id = Number(rawId);
  if (!rawId || !Number.isInteger(id) || id <= 0 || String(id) !== rawId) return null;

  if (prefix === "wi") {
    if (action === "view") return { type: "wi_view", id };
    if (action === "appv") return { type: "wi_appv", id };
    if (action === "clse") return { type: "wi_clse", id };
  }
  if (prefix === "job") {
    if (action === "cncl") return { type: "job_cncl", id };
  }
  if (prefix === "ap") {
    if (action === "yes") return { type: "ap_yes", id };
    if (action === "no") return { type: "ap_no", id };
  }
  if (prefix === "pr") {
    if (action === "hold") return { type: "pr_hold", id };
    if (action === "rels") return { type: "pr_rels", id };
    if (action === "rfsh") return { type: "pr_rfsh", id };
    if (action === "clse") return { type: "pr_clse", id };
  }
  return null;
}

export function buildWorkCallback(action: WorkCallbackAction): string {
  let prefix = "";
  let actionStr = "";
  if (action.type.startsWith("wi_")) {
    prefix = "wi";
    actionStr = action.type.slice(3);
  } else if (action.type.startsWith("job_")) {
    prefix = "job";
    actionStr = action.type.slice(4);
  } else if (action.type.startsWith("ap_")) {
    prefix = "ap";
    actionStr = action.type.slice(3);
  }
  const payload = `${prefix}:${action.id}:${actionStr}`;
  if (payload.length > 64) {
    throw new Error(`Callback payload exceeds 64 bytes limit: ${payload}`);
  }
  return payload;
}

function getWorkItemDetailsText(item: any): { text: string; inline_keyboard: any[] } {
  let textOut = `📦 **Work Item Details**\n\n`;
  textOut += `**Work Item ID**: ${item.id}\n`;
  textOut += `**Type**: \`${item.kind}\`\n`;
  textOut += `**Source**: \`${item.source}\`\n`;
  textOut += `**Repository**: \`${item.repository ?? "none"}\`\n`;
  textOut += `**Title**: ${item.title}\n`;
  textOut += `**Status**: \`${item.status}\`\n`;
  textOut += `**Priority**: \`${item.priority}\`\n`;
  textOut += `**Created By**: ${item.created_by}\n`;
  if (item.body) {
    const displayBody = item.body.length > 1000 ? item.body.slice(0, 997) + "..." : item.body;
    textOut += `**Body**:\n${displayBody}\n`;
  }
  textOut += `**Created At**: ${item.created_at}\n`;
  textOut += `**Updated At**: ${item.updated_at}\n`;

  const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  if (item.status === "proposed" || item.status === "needs_approval" || item.status === "waiting_approval") {
    inline_keyboard.push([
      { text: "✅ Approve", callback_data: `wi:${item.id}:appv` },
      { text: "❌ Close/Reject", callback_data: `wi:${item.id}:clse` }
    ]);
  }
  return { text: textOut.trim(), inline_keyboard };
}

function getIssuesListText(db: any): { text: string; inline_keyboard: any[] } {
  const items = db.listWorkItems();
  const proposed = items.filter((item: any) => item.status === "proposed" || item.status === "waiting_approval");
  if (proposed.length === 0) {
    return { text: "No proposed work items.", inline_keyboard: [] };
  }
  let textOut = "📦 **Proposed Work Items**\n\n";
  const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const item of proposed) {
    const displayTitle = item.title.length > 50 ? item.title.slice(0, 47) + "..." : item.title;
    textOut += `• **#${item.id}** | ${displayTitle} | status: \`${item.status}\`\n`;
    inline_keyboard.push([
      { text: `🔍 View #${item.id}`, callback_data: `wi:${item.id}:view` },
      { text: `✅ Approve #${item.id}`, callback_data: `wi:${item.id}:appv` },
      { text: `❌ Close #${item.id}`, callback_data: `wi:${item.id}:clse` }
    ]);
  }
  return { text: textOut.trim(), inline_keyboard };
}

function getJobsListText(db: any): { text: string; inline_keyboard: any[] } | null {
  const jobs = db.listWorkJobs();
  const activeJobs = jobs.filter((j: any) => j.status === "pending" || j.status === "leased" || j.status === "running");
  if (activeJobs.length === 0) {
    return { text: "No active or pending jobs.", inline_keyboard: [] };
  }
  let textOut = "📋 **Active and Pending Jobs**\n\n";
  const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const j of activeJobs) {
    textOut += `• **Job #${j.id}** | \`${j.task_type}\` | status: \`${j.status}\` | attempts: ${j.attempt_count}/${j.max_attempts}\n`;
    if (j.error) textOut += `  Error: \`${j.error}\`\n`;
    inline_keyboard.push([{ text: `🚫 Cancel #${j.id}`, callback_data: `job:${j.id}:cncl` }]);
  }
  return { text: textOut.trim(), inline_keyboard };
}

function getJobDetailsText(job: any): { text: string; inline_keyboard: any[] } {
  let textOut = `📋 **Job Details**\n\n`;
  textOut += `**Job ID**: ${job.id}\n`;
  textOut += `**Type**: \`${job.task_type}\`\n`;
  textOut += `**Status**: \`${job.status}\`\n`;
  textOut += `**Bot**: \`${job.bot ?? "none"}\`\n`;
  textOut += `**Lease Owner**: \`${job.lease_owner ?? "none"}\`\n`;
  textOut += `**Lease Expires At**: \`${job.lease_expires_at ?? "none"}\`\n`;
  textOut += `**Heartbeat At**: \`${job.heartbeat_at ?? "none"}\`\n`;
  textOut += `**Attempts**: ${job.attempt_count}/${job.max_attempts}\n`;
  textOut += `**Idempotency Key**: \`${job.idempotency_key}\`\n`;
  if (job.error) textOut += `**Error**: \`${job.error}\`\n`;
  if (job.result_json) textOut += `**Result**: \`${job.result_json.slice(0, 500)}\`\n`;
  textOut += `**Created At**: ${job.created_at}\n`;
  textOut += `**Updated At**: ${job.updated_at}\n`;

  const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  if (job.status === "pending" || job.status === "leased" || job.status === "running") {
    inline_keyboard.push([{ text: "🚫 Cancel Job", callback_data: `job:${job.id}:cncl` }]);
  }
  return { text: textOut.trim(), inline_keyboard };
}

function getApprovalDetailsText(appr: any): { text: string; inline_keyboard: any[] } {
  let textOut = `⚖️ **Approval Request Details**\n\n`;
  textOut += `**Approval ID**: ${appr.id}\n`;
  textOut += `**Type**: \`${appr.approval_type}\`\n`;
  textOut += `**Status**: \`${appr.status}\`\n`;
  textOut += `**Requested By**: \`${appr.requested_by}\`\n`;
  textOut += `**Requested At**: \`${appr.requested_at}\`\n`;
  if (appr.decided_by) {
    textOut += `**Decided By**: \`${appr.decided_by}\`\n`;
    textOut += `**Decided At**: \`${appr.decided_at}\`\n`;
  }
  if (appr.work_item_id) {
    textOut += `**Work Item ID**: ${appr.work_item_id}\n`;
  }
  if (appr.job_id) {
    textOut += `**Job ID**: ${appr.job_id}\n`;
  }

  const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  if (appr.status === "pending") {
    inline_keyboard.push([
      { text: "👍 Approve", callback_data: `ap:${appr.id}:yes` },
      { text: "👎 Reject", callback_data: `ap:${appr.id}:no` }
    ]);
  }
  return { text: textOut.trim(), inline_keyboard };
}

export async function handleWorkerCallback(
  cbq: any,
  db: any,
  client: any,
  allowedUserIds: Set<string>,
  extra?: { runCommand?: (binary: string, args: string[]) => Promise<string> }
): Promise<void> {
  const userId = cbq.from ? String(cbq.from.id) : "";
  if (!allowedUserIds.has(userId)) {
    await client.answerCallbackQuery({
      callback_query_id: cbq.id,
      text: "Unauthorized",
    });
    return;
  }

  const parsed = parseWorkCallback(cbq.data || "");
  const messageId = cbq.message?.message_id;
  const chatId = cbq.message?.chat?.id;

  // Check for merge-gate callbacks before falling through
  if (!parsed) {
    const prAction = parsePrMergeCallback(cbq.data || "");
    if (prAction) {
      const runGhCommand = createRunCommand({ loadGhToken: true });

      await handlePrMergeCallback(prAction, {
        db,
        runCommand: (binary, args) => runGhCommand(binary, args),
        answerCbq: (text?: string) =>
          client.answerCallbackQuery({ callback_query_id: cbq.id, ...(text ? { text } : {}) }),
        editMessage: (text: string, replyMarkup?: object) =>
          chatId && messageId
            ? editWithEntities(client, {
                chat_id: chatId,
                message_id: messageId,
                text,
                ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
              }).then(() => undefined)
            : Promise.resolve(),
        chatId,
        messageId,
        userId,
      });
      return;
    }

    await client.answerCallbackQuery({ callback_query_id: cbq.id });
    return;
  }

  if (parsed.type === "wi_view") {
    const item = db.getWorkItem(parsed.id);
    if (!item) {
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "Work item not found." });
      return;
    }
    const { text, inline_keyboard } = getWorkItemDetailsText(item);
    await client.answerCallbackQuery({ callback_query_id: cbq.id });
    if (chatId && messageId) {
      await editWithEntities(client, {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined,
      });
    }
  } else if (parsed.type === "wi_appv") {
    const item = db.getWorkItem(parsed.id);
    if (!item) {
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "Work item not found." });
      return;
    }
    db.updateWorkItemStatus(item.id, "approved");
    // Issue job first so the GitHub issue exists before implementation starts
    if (item.repository) {
      db.createWorkJob({
        task_type: "open_github_issue",
        idempotency_key: `gh_issue:${item.id}`,
        work_item_id: item.id,
        input_json: {
          work_item_id: item.id,
          repository: item.repository,
          ...(chatId != null ? { notify_chat_id: chatId } : {}),
        },
      });
    }
    db.createWorkJob({
      task_type: "tdd_implementation",
      idempotency_key: `tdd:${item.id}`,
      work_item_id: item.id,
      input_json: {
        work_item_id: item.id,
        ...(item.repository ? { repository: item.repository } : {}),
        ...(chatId != null ? { notify_chat_id: chatId } : {}),
      },
    });

    await client.answerCallbackQuery({ callback_query_id: cbq.id });
    if (chatId && messageId) {
      const updatedItem = db.getWorkItem(item.id);
      const isList = cbq.message?.text && cbq.message.text.includes("Proposed Work Items");
      const { text, inline_keyboard } = isList ? getIssuesListText(db) : getWorkItemDetailsText(updatedItem);
      await editWithEntities(client, {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined,
      });
    }
  } else if (parsed.type === "wi_clse") {
    const item = db.getWorkItem(parsed.id);
    if (!item) {
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "Work item not found." });
      return;
    }
    db.updateWorkItemStatus(item.id, "closed");
    for (const j of db
      .listWorkJobs()
      .filter((j: WorkJob) => j.work_item_id === item.id && (j.status === "pending" || j.status === "leased"))) {
      db.cancelWorkJob(j.id, "work item closed");
    }
    await client.answerCallbackQuery({ callback_query_id: cbq.id });
    if (chatId && messageId) {
      const updatedItem = db.getWorkItem(item.id);
      const isList = cbq.message?.text && cbq.message.text.includes("Proposed Work Items");
      const { text, inline_keyboard } = isList ? getIssuesListText(db) : getWorkItemDetailsText(updatedItem);
      await editWithEntities(client, {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined,
      });
    }
  } else if (parsed.type === "job_cncl") {
    const job = db.getWorkJob(parsed.id);
    if (!job) {
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "Job not found." });
      return;
    }
    db.cancelWorkJob(job.id, "Cancelled via Telegram callback");
    await client.answerCallbackQuery({ callback_query_id: cbq.id });
    if (chatId && messageId) {
      const updatedJob = db.getWorkJob(job.id);
      const isList = cbq.message?.text && cbq.message.text.includes("Active and Pending Jobs");
      const { text, inline_keyboard } = isList ? (getJobsListText(db) || { text: "No active or pending jobs.", inline_keyboard: [] }) : getJobDetailsText(updatedJob);
      await editWithEntities(client, {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined,
      });
    }
  } else if (parsed.type === "ap_yes") {
    const row = db.raw.prepare(`SELECT * FROM approvals WHERE id = ?`).get(parsed.id);
    if (!row) {
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "Approval request not found." });
      return;
    }
    db.resolveApproval(row.id, "approved", userId);
    await client.answerCallbackQuery({ callback_query_id: cbq.id });
    if (chatId && messageId) {
      const updatedRow = db.raw.prepare(`SELECT * FROM approvals WHERE id = ?`).get(row.id);
      const { text, inline_keyboard } = getApprovalDetailsText(updatedRow);
      await editWithEntities(client, {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined,
      });
    }
  } else if (parsed.type === "ap_no") {
    const row = db.raw.prepare(`SELECT * FROM approvals WHERE id = ?`).get(parsed.id);
    if (!row) {
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "Approval request not found." });
      return;
    }
    db.resolveApproval(row.id, "rejected", userId);
    await client.answerCallbackQuery({ callback_query_id: cbq.id });
    if (chatId && messageId) {
      const updatedRow = db.raw.prepare(`SELECT * FROM approvals WHERE id = ?`).get(row.id);
      const { text, inline_keyboard } = getApprovalDetailsText(updatedRow);
      await editWithEntities(client, {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: inline_keyboard.length > 0 ? { inline_keyboard } : undefined,
      });
    }
  } else if (parsed.type === "pr_hold") {
    const link = db.raw.prepare("SELECT * FROM github_links WHERE id = ?").get(parsed.id);
    if (!link) {
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "PR link not found." });
      return;
    }
    db.updatePrState(parsed.id, "held");
    await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "PR held — watch will skip until released." });
  } else if (parsed.type === "pr_rels") {
    const link = db.raw.prepare("SELECT * FROM github_links WHERE id = ?").get(parsed.id);
    if (!link) {
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "PR link not found." });
      return;
    }
    db.updatePrState(parsed.id, "draft");
    await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "PR released — watch will re-evaluate it." });
  } else if (parsed.type === "pr_rfsh") {
    const link = db.raw.prepare("SELECT * FROM github_links WHERE id = ?").get(parsed.id) as any;
    if (!link) {
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "PR link not found." });
      return;
    }
    db.createWorkJob({
      task_type: "pr_refresh",
      idempotency_key: `pr_rfsh:${link.id}:${Date.now()}`,
      work_item_id: link.work_item_id,
      input_json: {
        work_item_id: link.work_item_id,
        repository: link.repository,
        branch_name: link.branch_name,
        base_branch: "main",
        ...(chatId != null ? { notify_chat_id: chatId } : {}),
      },
      max_attempts: 1,
    });
    await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "Refresh job enqueued." });
  } else if (parsed.type === "pr_clse") {
    const link = db.raw.prepare("SELECT * FROM github_links WHERE id = ?").get(parsed.id) as any;
    if (!link) {
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "PR link not found." });
      return;
    }
    const runCommand = extra?.runCommand ?? createRunCommand({ loadGhToken: true });
    try {
      await runCommand("gh", ["pr", "close", String(link.pr_number), "--repo", link.repository]);
      db.updatePrState(parsed.id, "closed");
      if (link.work_item_id) db.updateWorkItemStatus(link.work_item_id, "closed");
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `PR #${link.pr_number} closed.` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `Failed to close: ${msg.slice(0, 200)}` });
    }
  }
}
