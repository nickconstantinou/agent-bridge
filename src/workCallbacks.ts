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
import type { BridgeDb, WorkJob } from "./db.js";
import { createRunCommand } from "./runCommandAsync.js";
import { toTelegramEntitiesText } from "./render.js";
import { activeWorkItemSettingKey, clearActiveWorkItem } from "./workerBot.js";
import { consumePendingRepoBrief, setPendingCustomRepo } from "./featureBriefCapture.js";
import { parseRepoSelectCallback, resolveGithubOwner } from "./repoRegistry.js";
import { buildPrApprovalPack, buildWorkItemApprovalPack, sendApprovalHtmlPack } from "./approvalHtml.js";
import { validateImplementationPlan } from "./implementationPlanQuality.js";

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
  } else if (action.type.startsWith("pr_")) {
    prefix = "pr";
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

function resolveSelectedRepository(repo: string): string {
  return repo.includes("/") ? repo : `${resolveGithubOwner()}/${repo}`;
}

async function sendPackWithFallback(client: any, chatId: number | undefined, pack: ReturnType<typeof buildWorkItemApprovalPack> | null): Promise<void> {
  if (chatId == null || !pack) return;
  try {
    await sendApprovalHtmlPack(client, chatId, pack);
  } catch (err) {
    console.warn("[worker-callbacks] approval pack send failed", err);
  }
}

function ensureImplementationPlanQueued(db: BridgeDb, itemId: number, chatId: number | undefined): boolean {
  const existing = db.listWorkJobs().find((j: WorkJob) => {
    if (j.work_item_id !== itemId || j.task_type !== "implementation_plan") return false;
    return j.status === "pending" || j.status === "leased" || j.status === "running";
  });
  if (existing) return false;
  db.createWorkJob({
    task_type: "implementation_plan",
    idempotency_key: `implementation_plan:${itemId}`,
    work_item_id: itemId,
    input_json: {
      work_item_id: itemId,
      approve_after_plan: true,
      ...(chatId != null ? { notify_chat_id: chatId } : {}),
    },
    max_attempts: 1,
  });
  return true;
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
  const repoSelect = parseRepoSelectCallback(cbq.data || "");

  if (repoSelect) {
    let repository: string;
    try {
      repository = resolveSelectedRepository(repoSelect.repo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: message.slice(0, 200) });
      return;
    }
    if (repoSelect.ctx === "r") {
      const job = db.createWorkJob({
        task_type: "defect_scan",
        idempotency_key: `scan:${repository}:${Date.now()}`,
        input_json: {
          repository,
          ...(chatId != null ? { notify_chat_id: chatId } : {}),
        },
      });
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `Review queued for ${repository}` });
      if (chatId && messageId) {
        await editWithEntities(client, {
          chat_id: chatId,
          message_id: messageId,
          text: `Defect scan queued for **${repository}** (Job #${job.id}).`,
        });
      }
      return;
    }

    if (repoSelect.ctx === "rf") {
      const job = db.createWorkJob({
        task_type: "refactor_scan",
        idempotency_key: `refactor:${repository}:${Date.now()}`,
        input_json: {
          repository,
          ...(chatId != null ? { notify_chat_id: chatId } : {}),
        },
      });
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `Refactor scan queued for ${repository}` });
      if (chatId && messageId) {
        await editWithEntities(client, {
          chat_id: chatId,
          message_id: messageId,
          text: `Refactor scan queued for **${repository}** (Job #${job.id}).`,
        });
      }
      return;
    }

    if (repoSelect.ctx === "f") {
      if (chatId == null) {
        await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "Missing chat context." });
        return;
      }
      const brief = consumePendingRepoBrief(String(chatId));
      if (!brief) {
        await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "No pending feature brief." });
        return;
      }
      const plan = db.createFeaturePlan({
        chatId: String(chatId),
        userId,
        brief,
      });
      const job = db.createWorkJob({
        task_type: "feature_plan",
        idempotency_key: `feature_plan:${plan.id}`,
        input_json: {
          plan_id: plan.id,
          repository,
          notify_chat_id: chatId,
          start_message: `Analysing codebase and drafting plan for **${brief}**... This takes 1–3 minutes.`,
        },
      });
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `Feature plan queued for ${repository}` });
      if (chatId && messageId) {
        await editWithEntities(client, {
          chat_id: chatId,
          message_id: messageId,
          text: `Feature plan queued for **${repository}** (Job #${job.id}).`,
        });
      }
      return;
    }

    await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "Unknown repo action." });
    return;
  }

  // gi:<repo-or-owner/repo>:<issuenum> — import a GitHub issue and create a work item
  if ((cbq.data || "").startsWith("gi:")) {
    const parts = (cbq.data || "").split(":");
    if (parts.length === 3) {
      const repoToken = parts[1];
      const issueNum = Number(parts[2]);
      if (repoToken && issueNum > 0) {
        let owner = "";
        try { owner = resolveGithubOwner(); } catch { /* fallback: no prefix */ }
        const fullRepo = repoToken.includes("/") ? repoToken : (owner ? `${owner}/${repoToken}` : repoToken);
        const existingLink = db.getGithubIssueLink(fullRepo, issueNum);
        if (existingLink) {
          const existingItem = db.getWorkItem(existingLink.work_item_id);
          if (existingItem) {
            await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `Already imported as work item #${existingItem.id}` });
            if (chatId && messageId) {
              await editWithEntities(client, {
                chat_id: chatId,
                message_id: messageId,
                text: `Issue #${issueNum} in \`${fullRepo}\` is already imported as work item #${existingItem.id}.\n\nApprove to start implementation.`,
                reply_markup: {
                  inline_keyboard: [[
                    { text: "✅ Approve", callback_data: `wi:${existingItem.id}:appv` },
                    { text: "❌ Close/Reject", callback_data: `wi:${existingItem.id}:clse` },
                  ]],
                },
              });
            }
            return;
          }
        }
        const runGhCommand = extra?.runCommand ?? createRunCommand({ loadGhToken: true });
        let issueData: { number: number; title: string; body: string; labels: Array<{ name: string }> };
        try {
          const raw = await runGhCommand("gh", [
            "issue", "view", String(issueNum), "--repo", fullRepo,
            "--json", "number,title,body,labels",
          ]);
          issueData = JSON.parse(raw);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `Failed: ${msg.slice(0, 200)}` });
          return;
        }
        const labelNames = (issueData.labels ?? []).map((l: { name: string }) => l.name.toLowerCase());
        const kind = labelNames.some(l => l.includes("bug") || l.includes("defect")) ? "defect"
          : labelNames.some(l => l.includes("refactor")) ? "refactor"
          : "feature";
        const item = db.createWorkItem({
          kind,
          source: "github",
          title: issueData.title,
          body: issueData.body ?? "",
          created_by: userId,
          repository: fullRepo,
          priority: "normal",
        });
        db.linkGithubIssue({ work_item_id: item.id, repository: fullRepo, issue_number: issueNum });
        await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `Imported #${issueNum} as work item #${item.id}` });
        if (chatId && messageId) {
          await editWithEntities(client, {
            chat_id: chatId,
            message_id: messageId,
            text: `Imported **#${issueNum} ${issueData.title}** as work item #${item.id}.\nRepository: \`${fullRepo}\`\n\nApprove to start implementation.`,
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Approve", callback_data: `wi:${item.id}:appv` },
                { text: "❌ Close/Reject", callback_data: `wi:${item.id}:clse` },
              ]],
            },
          });
        }
        return;
      }
    }
    await client.answerCallbackQuery({ callback_query_id: cbq.id });
    return;
  }

  // rd:<name> or rd:__custom__ — set per-chat default repo
  if ((cbq.data || "").startsWith("rd:")) {
    const repoToken = (cbq.data || "").slice(3);
    if (repoToken === "__custom__") {
      const chatKey = chatId != null ? String(chatId) : null;
      if (chatKey) setPendingCustomRepo(chatKey);
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: "Send me the repo as owner/repo:" });
      if (chatId && messageId) {
        await editWithEntities(client, {
          chat_id: chatId,
          message_id: messageId,
          text: "Send the repo in `owner/repo` format (e.g. `microsoft/vscode`):",
        });
      }
      return;
    }
    if (repoToken) {
      let fullRepo: string;
      try {
        const owner = resolveGithubOwner();
        fullRepo = repoToken.includes("/") ? repoToken : `${owner}/${repoToken}`;
      } catch {
        fullRepo = repoToken;
      }
      if (chatId != null) db.setChatRepo(String(chatId), fullRepo);
      await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `Default repo set to ${fullRepo}` });
      if (chatId && messageId) {
        await editWithEntities(client, {
          chat_id: chatId,
          message_id: messageId,
          text: `Default repo set to \`${fullRepo}\` for this chat.`,
        });
      }
      return;
    }
    await client.answerCallbackQuery({ callback_query_id: cbq.id });
    return;
  }

  // Check for merge-gate callbacks before falling through
  if (!parsed) {
    const prAction = parsePrMergeCallback(cbq.data || "");
    if (prAction) {
      const runGhCommand = extra?.runCommand ?? createRunCommand({ loadGhToken: true });
      await sendPackWithFallback(client, chatId, buildPrApprovalPack(db, prAction.id));

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
    if (chatId != null) db.setSetting(activeWorkItemSettingKey(chatId), String(item.id));
    const { text, inline_keyboard } = getWorkItemDetailsText(item);
    await sendPackWithFallback(client, chatId, buildWorkItemApprovalPack(db, item));
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
    if (!item.repository) {
      await client.answerCallbackQuery({
        callback_query_id: cbq.id,
        text: "Cannot approve: work item has no repository.",
      });
      return;
    }
    const storedPlan = db.getWorkItemPlan(item.id);
    const planQuality = validateImplementationPlan(storedPlan?.plan_text);
    if (!planQuality.valid) {
      ensureImplementationPlanQueued(db, item.id, chatId);
      await client.answerCallbackQuery({
        callback_query_id: cbq.id,
        text: "Implementation plan queued. Work will continue automatically when it is ready.",
      });
      if (chatId && messageId) {
        await editWithEntities(client, {
          chat_id: chatId,
          message_id: messageId,
          text: `Implementation plan queued for work item #${item.id}.\n\nNo further approval tap needed. The worker will improve the plan and continue automatically.`,
        });
      }
      return;
    }
    await sendPackWithFallback(client, chatId, buildWorkItemApprovalPack(db, item));
    clearActiveWorkItem(db, chatId);
    db.updateWorkItemStatus(item.id, "approved");
    // Skip open_github_issue when the issue was imported from GitHub (already exists)
    const hasLinkedIssue = (db.raw.prepare(
      `SELECT 1 FROM github_links WHERE work_item_id = ? AND issue_number IS NOT NULL LIMIT 1`,
    ).get(item.id) as { 1: number } | undefined) != null;
    if (!hasLinkedIssue) {
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
    clearActiveWorkItem(db, chatId);
    db.updateWorkItemStatus(item.id, "closed");
    for (const j of db
      .listWorkJobs()
      .filter((j: WorkJob) => j.work_item_id === item.id && (j.status === "pending" || j.status === "leased" || j.status === "running"))) {
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
