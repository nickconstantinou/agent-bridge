/**
 * PURPOSE: Worker bot — autonomous job queue control surface.
 * Handles /jobs, /issues, /review commands. Queues work items when the schema
 * is available (Phase 1+). Phase 0: acknowledgement stubs only.
 * NEIGHBORS: src/index-worker.ts, src/db.ts
 */

import type { BridgeDb } from "./db.js";
import { setPendingFeatureBrief, setPendingRepoBrief } from "./featureBriefCapture.js";
import { closeLinkedIssueForMergedPr } from "./githubIssueClosure.js";
import { buildRepoKeyboard, buildRepoSetKeyboard, resolveGithubOwner } from "./repoRegistry.js";
import { createRunCommand } from "./runCommandAsync.js";

const DEFAULT_CLI_CHAIN = ["codex", "claude", "antigravity"];
const ACTIVE_WORK_ITEM_PREFIX = "active_work_item:";

export interface WorkerCommandContext {
  workerEnabled: boolean;
  cliChain?: string[];
  db?: BridgeDb;
  chatId?: number;
  userId?: string;
  defaultRepo?: string;
  runCommand?: (binary: string, args: string[]) => Promise<string>;
}

export interface WorkerMessageResult {
  kind: "message";
  text: string;
}

export interface WorkerKeyboardMessageResult {
  kind: "keyboard_message";
  text: string;
  reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

export type WorkerCommandResult = WorkerMessageResult | WorkerKeyboardMessageResult;

const WORKER_COMMANDS = new Set([
  "/jobs", "/issues", "/review", "/models", "/job", "/issue", "/feature",
  "/approvals", "/refactor", "/github-issues", "/github_issues",
  "/import-issue", "/import_issue", "/repo",
]);

export function activeWorkItemSettingKey(chatId: number | string): string {
  return `${ACTIVE_WORK_ITEM_PREFIX}${chatId}`;
}

function setActiveWorkItem(db: BridgeDb | undefined, chatId: number | undefined, workItemId: number): void {
  if (!db || chatId == null) return;
  db.setSetting(activeWorkItemSettingKey(chatId), String(workItemId));
}

export function clearActiveWorkItem(db: BridgeDb | undefined, chatId: number | undefined): void {
  if (!db || chatId == null) return;
  db.setSetting(activeWorkItemSettingKey(chatId), null);
}

function buildAmendedBody(existingBody: string | null, amendment: string, userId?: string): string {
  const prefix = existingBody?.trim() ? `${existingBody.trim()}\n\n` : "";
  const user = userId ? ` by ${userId}` : "";
  return `${prefix}Operator amendment${user}:\n${amendment.trim()}`;
}

export function buildWorkerCommands(): Array<{ command: string; description: string }> {
  return [
    { command: "jobs",    description: "List active and pending jobs" },
    { command: "issues",  description: "List proposed work items" },
    { command: "review",  description: "Trigger a defect scan: /review [repo]" },
    { command: "feature", description: "Plan a new feature: /feature <brief description>" },
    { command: "approvals", description: "List pending approvals with their action buttons" },
    { command: "refactor", description: "Analyse code quality: /refactor [repo]" },
    { command: "github_issues", description: "List open GitHub issues: /github-issues [repo]" },
    { command: "import_issue", description: "Import GitHub issue: /import-issue repo#123" },
    { command: "repo",    description: "Switch default repo: /repo" },
    { command: "models",  description: "Show CLI execution chain" },
  ];
}

function normalizeCommand(text: string): string {
  return text.trim().toLowerCase().split(/\s+/)[0].replace(/@\S+$/, "");
}

function parsePrUrl(prUrl: string | undefined): { repository?: string; pr_number?: number } {
  const match = prUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (!match) return {};
  return { repository: match[1], pr_number: Number(match[2]) };
}

function parseApprovalPayload(payloadJson: string): { pr_url?: string; pr_number?: number; repository?: string } {
  try {
    const payload = JSON.parse(payloadJson) as { pr_url?: string; pr_number?: number; repository?: string };
    const parsedUrl = parsePrUrl(payload.pr_url);
    return {
      ...payload,
      repository: payload.repository ?? parsedUrl.repository,
      pr_number: payload.pr_number ?? parsedUrl.pr_number,
    };
  } catch {
    return {};
  }
}

async function reconcilePendingMergeApprovals(
  db: BridgeDb,
  runCommand?: (binary: string, args: string[]) => Promise<string>,
): Promise<void> {
  const pending = db.raw.prepare(
    `SELECT * FROM approvals WHERE approval_type = 'merge_pr' AND status = 'pending' ORDER BY id ASC`,
  ).all() as Array<{ id: number; work_item_id: number | null; payload_json: string }>;

  for (const approval of pending) {
    if (approval.work_item_id == null) continue;
    const payload = parseApprovalPayload(approval.payload_json);
    const repo = payload.repository ?? "";
    const prNumber = payload.pr_number;
    let state: string | null = null;

    const link = prNumber != null
      ? db.raw.prepare("SELECT id, pr_state FROM github_links WHERE work_item_id = ? AND pr_number = ?")
          .get(approval.work_item_id, prNumber) as { id: number; pr_state: string } | undefined
      : undefined;

    if (runCommand && repo && prNumber != null) {
      try {
        const raw = await runCommand("gh", ["pr", "view", String(prNumber), "--repo", repo, "--json", "state"]);
        state = String((JSON.parse(raw) as { state?: string }).state ?? "").toLowerCase();
      } catch {
        state = null;
      }
    }
    state ??= link?.pr_state ?? null;

    if (state === "merged") {
      db.resolveApproval(approval.id, "approved", "github-reconcile");
      db.updateWorkItemStatus(approval.work_item_id, "resolved");
      if (link) db.updatePrState(link.id, "merged");
      if (runCommand) await closeLinkedIssueForMergedPr(db, runCommand, approval.work_item_id, repo, prNumber);
    } else if (state === "closed") {
      db.resolveApproval(approval.id, "rejected", "github-reconcile");
      db.updateWorkItemStatus(approval.work_item_id, "closed");
      if (link) db.updatePrState(link.id, "closed");
    }
  }
}

export function isWorkerCommand(text: string): boolean {
  const cmd = normalizeCommand(text);
  if (WORKER_COMMANDS.has(cmd)) return true;
  if (text.trim().toLowerCase().startsWith("/review ")) return true;
  if (text.trim().toLowerCase().startsWith("/job ")) return true;
  if (text.trim().toLowerCase().startsWith("/issue ")) return true;
  if (text.trim().toLowerCase().startsWith("/feature ")) return true;
  if (text.trim().toLowerCase().startsWith("/refactor ")) return true;
  if (text.trim().toLowerCase().startsWith("/github-issues ")) return true;
  if (text.trim().toLowerCase().startsWith("/github_issues ")) return true;
  if (text.trim().toLowerCase().startsWith("/import-issue ")) return true;
  if (text.trim().toLowerCase().startsWith("/import_issue ")) return true;
  return false;
}

export async function handleWorkerCommand(
  text: string,
  ctx: WorkerCommandContext,
): Promise<WorkerCommandResult | null> {
  const trimmed = text.trim();
  const cmd = normalizeCommand(trimmed);
  const db = ctx.db;

  if (cmd === "/jobs") {
    if (!ctx.workerEnabled) {
      return { kind: "message", text: "No jobs — worker is not yet active (WORKER_ENABLED=false).\nEnable it once Phase 1 schema is deployed." };
    }
    if (!db) {
      return { kind: "message", text: "No jobs queued." };
    }
    const jobs = db.listWorkJobs();
    const activeJobs = jobs.filter(j => j.status === "pending" || j.status === "leased" || j.status === "running");
    if (activeJobs.length === 0) {
      return { kind: "message", text: "No active or pending jobs." };
    }
    let textOut = "📋 **Active and Pending Jobs**\n\n";
    const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const j of activeJobs) {
      textOut += `• **Job #${j.id}** | \`${j.task_type}\` | status: \`${j.status}\` | attempts: ${j.attempt_count}/${j.max_attempts}\n`;
      if (j.error) textOut += `  Error: \`${j.error}\`\n`;
      inline_keyboard.push([{ text: `🚫 Cancel #${j.id}`, callback_data: `job:${j.id}:cncl` }]);
    }
    return { kind: "keyboard_message", text: textOut.trim(), reply_markup: { inline_keyboard } };
  }

  if (cmd === "/job") {
    if (!ctx.workerEnabled) {
      return { kind: "message", text: "Worker is not yet active (WORKER_ENABLED=false)." };
    }
    if (!db) {
      return { kind: "message", text: "Database not available." };
    }
    const parts = trimmed.split(/\s+/);
    const id = Number(parts[1]);
    if (!parts[1] || !Number.isInteger(id) || id <= 0) {
      return { kind: "message", text: "Invalid job ID." };
    }
    const job = db.getWorkJob(id);
    if (!job) {
      return { kind: "message", text: `Job ${id} not found.` };
    }
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
    return { kind: "keyboard_message", text: textOut.trim(), reply_markup: { inline_keyboard } };
  }

  if (cmd === "/issues") {
    if (!ctx.workerEnabled) {
      return { kind: "message", text: "No issues — worker is not yet active (WORKER_ENABLED=false).\nEnable it once Phase 1 schema is deployed." };
    }
    if (!db) {
      return { kind: "message", text: "No work items yet." };
    }
    const items = db.listWorkItems();
    const proposed = items.filter(item => item.status === "proposed" || item.status === "waiting_approval");
    if (proposed.length === 0) {
      return { kind: "message", text: "No proposed work items." };
    }
    let textOut = "📦 **Proposed Work Items**\n\n";
    const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const item of proposed) {
      const displayTitle = item.title.length > 50 ? item.title.slice(0, 47) + "..." : item.title;
      textOut += `• **#${item.id}** | ${displayTitle} | repo: \`${item.repository ?? "none"}\` | status: \`${item.status}\`\n`;
      inline_keyboard.push([
        { text: `🔍 View #${item.id}`, callback_data: `wi:${item.id}:view` },
        { text: `✅ Approve #${item.id}`, callback_data: `wi:${item.id}:appv` },
        { text: `❌ Close #${item.id}`, callback_data: `wi:${item.id}:clse` }
      ]);
    }
    return { kind: "keyboard_message", text: textOut.trim(), reply_markup: { inline_keyboard } };
  }

  if (cmd === "/issue") {
    if (!ctx.workerEnabled) {
      return { kind: "message", text: "Worker is not yet active (WORKER_ENABLED=false)." };
    }
    if (!db) {
      return { kind: "message", text: "Database not available." };
    }
    const parts = trimmed.split(/\s+/);
    const id = Number(parts[1]);
    if (!parts[1] || !Number.isInteger(id) || id <= 0) {
      return { kind: "message", text: "Invalid issue ID." };
    }
    const item = db.getWorkItem(id);
    if (!item) {
      return { kind: "message", text: `Work item ${id} not found.` };
    }
    setActiveWorkItem(db, ctx.chatId, item.id);
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
    if (item.status === "proposed" || item.status === "waiting_approval") {
      inline_keyboard.push([
        { text: "✅ Approve", callback_data: `wi:${item.id}:appv` },
        { text: "❌ Close/Reject", callback_data: `wi:${item.id}:clse` }
      ]);
    }
    return { kind: "keyboard_message", text: textOut.trim(), reply_markup: { inline_keyboard } };
  }

  if (cmd === "/feature") {
    const parts = trimmed.split(/\s+/);
    const brief = parts.slice(1).join(" ").trim();

    if (!brief) {
      if (ctx.chatId != null) setPendingFeatureBrief(String(ctx.chatId));
      return {
        kind: "message",
        text: "Describe the feature you'd like to build. Your next message will be used as the brief.\n\nOr include it inline: `/feature add dark mode support to the dashboard`",
      };
    }

    if (db && ctx.chatId != null) {
      const chatKey = String(ctx.chatId);
      const userId = ctx.userId ?? "unknown";
      const defaultRepo = ctx.defaultRepo || process.env.WORKER_DEFAULT_REPO;
      if (!defaultRepo) {
        setPendingRepoBrief(chatKey, brief);
        const keyboard = await buildRepoKeyboard("f");
        if (keyboard) {
          return {
            kind: "keyboard_message",
            text: `Which repo should I use for this feature?\n\n${brief}`,
            reply_markup: keyboard,
          };
        }
        return {
          kind: "message",
          text: "Which repo should I use? Configure `WORKER_DEFAULT_REPO` or use `/feature <brief>` after setting a repo.",
        };
      }
      const plan = db.createFeaturePlan({ chatId: chatKey, userId, brief });
      const jobInput: Record<string, unknown> = {
        plan_id: plan.id,
        notify_chat_id: ctx.chatId,
        start_message: `Analysing codebase and drafting plan for **${brief}**... This takes 1–3 minutes.`,
      };
      jobInput.repository = defaultRepo;
      db.createWorkJob({
        task_type: "feature_plan",
        idempotency_key: `feature_plan:${plan.id}`,
        input_json: jobInput,
      });
      const repoNote = defaultRepo ? `\nRepository: \`${defaultRepo}\`` : "\nRepository: `none` — set one before approval.";
      return {
        kind: "message",
        text: `Feature plan started: **${brief}**${repoNote}\n\nAnalysing the codebase and drafting an implementation plan. Use /issues to view the result when it's ready.`,
      };
    }

    return {
      kind: "message",
      text: `Feature plan received: **${brief}**\n\nUse /issues to track progress once the worker is active.`,
    };
  }

  if (cmd === "/approvals") {
    if (!ctx.workerEnabled) {
      return { kind: "message", text: "Worker is not yet active (WORKER_ENABLED=false)." };
    }
    if (!db) {
      return { kind: "message", text: "Database not available." };
    }
    await reconcilePendingMergeApprovals(db, ctx.runCommand);

    const pending = db.raw.prepare(
      `SELECT * FROM approvals WHERE status = 'pending' ORDER BY id ASC`
    ).all() as Array<{ id: number; approval_type: string; work_item_id: number | null; requested_at: string; payload_json: string }>;

    if (pending.length === 0) {
      return { kind: "message", text: "No pending approvals." };
    }

    let textOut = "⚖️ **Pending Approvals**\n\n";
    const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (const appr of pending) {
      const payload = parseApprovalPayload(appr.payload_json);

      textOut += `• **#${appr.id}** | \`${appr.approval_type}\``;
      if (appr.work_item_id != null) textOut += ` | work item #${appr.work_item_id}`;
      textOut += `\n  Requested: ${appr.requested_at}\n`;
      if (payload.pr_url) textOut += `  PR: ${payload.pr_url}\n`;
      if (appr.work_item_id != null) {
        const issueLink = db.raw.prepare(
          `SELECT repository, issue_number FROM github_links WHERE work_item_id = ? AND issue_number IS NOT NULL LIMIT 1`
        ).get(appr.work_item_id) as { repository: string; issue_number: number } | undefined;
        if (issueLink) {
          textOut += `  Issue: https://github.com/${issueLink.repository}/issues/${issueLink.issue_number}\n`;
        }
      }

      if (appr.approval_type === "merge_pr" && appr.work_item_id != null) {
        inline_keyboard.push([
          { text: `✅ Merge PR (wi #${appr.work_item_id})`, callback_data: `wi:${appr.work_item_id}:mrgpr` },
          { text: `❌ Close PR (wi #${appr.work_item_id})`, callback_data: `wi:${appr.work_item_id}:clspr` },
        ]);
      } else {
        inline_keyboard.push([
          { text: `👍 Approve #${appr.id}`, callback_data: `ap:${appr.id}:yes` },
          { text: `👎 Reject #${appr.id}`, callback_data: `ap:${appr.id}:no` },
        ]);
      }
    }
    return { kind: "keyboard_message", text: textOut.trim(), reply_markup: { inline_keyboard } };
  }

  if (cmd === "/models") {
    const chain = ctx.cliChain ?? DEFAULT_CLI_CHAIN;
    return {
      kind: "keyboard_message",
      text: `[worker CLI chain]\n\nExecution order: ${chain.join(" → ")}\n\nOn failure, the next CLI in the chain is tried. Merge approval always requires your explicit confirmation.`,
      reply_markup: {
        inline_keyboard: chain.map((cli) => [{ text: cli, callback_data: `worker:cli:${cli}` }]),
      },
    };
  }

  if (cmd === "/review") {
    const parts = trimmed.split(/\s+/);
    const repo = parts.slice(1).join(" ").trim() || null;
    const targetRepo = repo || ctx.defaultRepo || process.env.WORKER_DEFAULT_REPO || null;
    const repoNote = targetRepo ? ` for **${targetRepo}**` : "";

    if (!ctx.workerEnabled) {
      return {
        kind: "message",
        text: `Review request${repoNote} received — worker is not yet active (WORKER_ENABLED=false).\nEnable it once Phase 1 schema is deployed.`,
      };
    }
    if (!db) {
      return {
        kind: "message",
        text: `Defect scan queued${repoNote}. Use /jobs to check progress.`,
      };
    }
    if (!targetRepo) {
      const keyboard = await buildRepoKeyboard("r");
      if (keyboard) {
        return {
          kind: "keyboard_message",
          text: "Which repo should I scan for defects?",
          reply_markup: keyboard,
        };
      }
      return {
        kind: "message",
        text: "Which repo should I review? Use `/review <owner/repo>` or configure `WORKER_DEFAULT_REPO`.",
      };
    }

    const activeJobs = db.listWorkJobs().filter(
      j => j.task_type === "defect_scan" &&
           j.idempotency_key.startsWith(`scan:${targetRepo}:`) &&
           (j.status === "pending" || j.status === "leased" || j.status === "running")
    );
    if (activeJobs.length > 0) {
      return {
        kind: "message",
        text: `Defect scan already in progress for **${targetRepo}** (Job ID: ${activeJobs[0].id}). Use /job ${activeJobs[0].id} to view.`,
      };
    }

    const input: Record<string, unknown> = { repository: targetRepo };
    if (ctx.chatId != null) input.notify_chat_id = ctx.chatId;

    const newJob = db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: `scan:${targetRepo}:${Date.now()}`,
      input_json: input,
    });

    return {
      kind: "message",
      text: `Defect scan queued for **${targetRepo}** (Job ID: ${newJob.id}). Use /jobs to check progress.`,
    };
  }

  if (cmd === "/refactor") {
    const parts = trimmed.split(/\s+/);
    const repo = parts.slice(1).join(" ").trim() || null;
    const targetRepo = repo || ctx.defaultRepo || process.env.WORKER_DEFAULT_REPO || null;
    const repoNote = targetRepo ? ` for **${targetRepo}**` : "";

    if (!ctx.workerEnabled) {
      return {
        kind: "message",
        text: `Refactor analysis${repoNote} received — worker is not yet active (WORKER_ENABLED=false).`,
      };
    }
    if (!db) {
      return { kind: "message", text: `Refactor analysis queued${repoNote}. Use /jobs to check progress.` };
    }
    if (!targetRepo) {
      const keyboard = await buildRepoKeyboard("rf");
      if (keyboard) {
        return {
          kind: "keyboard_message",
          text: "Which repo should I analyse for refactoring opportunities?",
          reply_markup: keyboard,
        };
      }
      return {
        kind: "message",
        text: "Which repo? Use `/refactor <owner/repo>` or configure `WORKER_DEFAULT_REPO`.",
      };
    }

    const activeJobs = db.listWorkJobs().filter(
      (j: any) => j.task_type === "refactor_scan" &&
           j.idempotency_key.startsWith(`refactor:${targetRepo}:`) &&
           (j.status === "pending" || j.status === "leased" || j.status === "running")
    );
    if (activeJobs.length > 0) {
      return {
        kind: "message",
        text: `Refactor scan already in progress for **${targetRepo}** (Job ID: ${activeJobs[0].id}).`,
      };
    }

    const input: Record<string, unknown> = { repository: targetRepo };
    if (ctx.chatId != null) input.notify_chat_id = ctx.chatId;

    const newJob = db.createWorkJob({
      task_type: "refactor_scan",
      idempotency_key: `refactor:${targetRepo}:${Date.now()}`,
      input_json: input,
    });

    return {
      kind: "message",
      text: `Refactor scan started for **${targetRepo}** (Job #${newJob.id}). Use /jobs to track progress.`,
    };
  }

  if (cmd === "/github-issues" || cmd === "/github_issues") {
    const parts = trimmed.split(/\s+/);
    const repoArg = parts.slice(1).join(" ").trim() || null;
    const targetRepo = repoArg || ctx.defaultRepo || process.env.WORKER_DEFAULT_REPO || null;

    if (!targetRepo) {
      const keyboard = await buildRepoKeyboard("gi");
      if (keyboard) {
        return {
          kind: "keyboard_message",
          text: "Which repo's issues should I list?",
          reply_markup: keyboard,
        };
      }
      return { kind: "message", text: "Specify a repo: `/github-issues <owner/repo>`" };
    }

    let owner: string;
    try { owner = resolveGithubOwner(); } catch { owner = ""; }
    const fullRepo = targetRepo.includes("/") ? targetRepo : (owner ? `${owner}/${targetRepo}` : targetRepo);

    let issueList: Array<{ number: number; title: string }> = [];
    try {
      const runGh = createRunCommand({ loadGhToken: true });
      const raw = await runGh("gh", [
        "issue", "list", "--repo", fullRepo,
        "--state", "open", "--limit", "20",
        "--json", "number,title",
      ]);
      issueList = JSON.parse(raw) as Array<{ number: number; title: string }>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: "message", text: `Failed to list issues for **${fullRepo}**: ${msg.slice(0, 300)}` };
    }

    if (issueList.length === 0) {
      return { kind: "message", text: `No open issues found in **${fullRepo}**.` };
    }

    const inline_keyboard = issueList.map(i => {
      const label = `#${i.number} ${i.title}`.slice(0, 60);
      const cbData = `gi:${fullRepo}:${i.number}`;
      return cbData.length <= 64 ? [{ text: label, callback_data: cbData }] : [];
    }).filter(row => row.length > 0);

    return {
      kind: "keyboard_message",
      text: `Open issues in **${fullRepo}** — tap one to import:`,
      reply_markup: { inline_keyboard },
    };
  }

  if (cmd === "/import-issue" || cmd === "/import_issue") {
    // Accept: /import-issue repo#123  OR  /import_issue owner/repo#123  OR  /import-issue repo 123
    const arg = trimmed.slice(cmd.length).trim();
    let repoName = "";
    let issueNum = 0;
    const hashMatch = arg.match(/^(.+?)#(\d+)$/);
    const spaceMatch = arg.match(/^(.+?)\s+(\d+)$/);
    if (hashMatch) { repoName = hashMatch[1].trim(); issueNum = Number(hashMatch[2]); }
    else if (spaceMatch) { repoName = spaceMatch[1].trim(); issueNum = Number(spaceMatch[2]); }

    if (!repoName || !issueNum) {
      return { kind: "message", text: "Usage: `/import-issue owner/repo#123` or `/import-issue repo 123`" };
    }

    let owner: string;
    try { owner = resolveGithubOwner(); } catch { owner = ""; }
    const fullRepo = repoName.includes("/") ? repoName : (owner ? `${owner}/${repoName}` : repoName);

    if (!db) return { kind: "message", text: "Database not available." };

    const existingLink = db.getGithubIssueLink(fullRepo, issueNum);
    if (existingLink) {
      const existingItem = db.getWorkItem(existingLink.work_item_id);
      if (existingItem) {
        setActiveWorkItem(db, ctx.chatId, existingItem.id);
        return {
          kind: "keyboard_message",
          text: `Issue #${issueNum} in **${fullRepo}** is already imported as work item #${existingItem.id}.\n\nReview and approve to start implementation.`,
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Approve", callback_data: `wi:${existingItem.id}:appv` },
              { text: "❌ Close/Reject", callback_data: `wi:${existingItem.id}:clse` },
            ]],
          },
        };
      }
    }

    let issueData: { number: number; title: string; body: string; labels: Array<{ name: string }> };
    try {
      const runGh = createRunCommand({ loadGhToken: true });
      const raw = await runGh("gh", [
        "issue", "view", String(issueNum), "--repo", fullRepo,
        "--json", "number,title,body,labels",
      ]);
      issueData = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind: "message", text: `Failed to fetch issue #${issueNum} from **${fullRepo}**: ${msg.slice(0, 300)}` };
    }

    const labelNames = issueData.labels?.map((l: { name: string }) => l.name.toLowerCase()) ?? [];
    const kind = labelNames.some(l => l.includes("bug") || l.includes("defect")) ? "defect"
      : labelNames.some(l => l.includes("refactor")) ? "refactor"
      : "feature";

    const item = db.createWorkItem({
      kind,
      source: "github",
      title: issueData.title,
      body: issueData.body ?? "",
      created_by: ctx.userId ?? "operator",
      repository: fullRepo,
      priority: "normal",
    });

    db.linkGithubIssue({ work_item_id: item.id, repository: fullRepo, issue_number: issueNum });

    const repoNote = `\nRepository: \`${fullRepo}\` (Issue #${issueNum})`;
    return {
      kind: "keyboard_message",
      text: `Imported **#${issueNum} ${issueData.title}** as work item #${item.id}.${repoNote}\n\nReview and approve to start implementation.`,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `wi:${item.id}:appv` },
          { text: "❌ Close/Reject", callback_data: `wi:${item.id}:clse` },
        ]],
      },
    };
  }

  if (cmd === "/repo") {
    if (!db) return { kind: "message", text: "Worker not available." };
    const chatKey = String(ctx.chatId ?? "");
    const chatRepo = chatKey ? db.getChatRepo(chatKey) : null;
    const effectiveRepo = chatRepo ?? process.env.WORKER_DEFAULT_REPO ?? null;
    const currentLabel = effectiveRepo
      ? `Current default: \`${effectiveRepo}\`` + (chatRepo ? " *(chat override)*" : " *(env)*")
      : "No default repo configured.";
    const keyboard = await buildRepoSetKeyboard();
    return {
      kind: "keyboard_message",
      text: `**Repo switcher**\n${currentLabel}\n\nPick a repo to set as default for this chat, or enter a custom one:`,
      reply_markup: keyboard,
    };
  }

  return null;
}

export function handleWorkerConversationText(
  text: string,
  ctx: WorkerCommandContext,
): WorkerCommandResult | null {
  const trimmed = text.trim();
  if (!trimmed || !ctx.db || ctx.chatId == null) return null;

  const activeId = ctx.db.getSetting(activeWorkItemSettingKey(ctx.chatId));
  if (!activeId) return null;

  const id = Number(activeId);
  if (!Number.isInteger(id) || id <= 0) {
    clearActiveWorkItem(ctx.db, ctx.chatId);
    return null;
  }

  const item = ctx.db.getWorkItem(id);
  if (!item) {
    clearActiveWorkItem(ctx.db, ctx.chatId);
    return { kind: "message", text: `Active work item #${id} no longer exists. Context cleared.` };
  }

  const editableStatuses = new Set(["proposed", "needs_approval", "waiting_approval"]);
  if (!editableStatuses.has(item.status)) {
    clearActiveWorkItem(ctx.db, ctx.chatId);
    return {
      kind: "message",
      text: `Item #${item.id} is already ${item.status}. Use an explicit revise/requeue action instead of casual follow-up edits.`,
    };
  }

  const nextBody = buildAmendedBody(item.body, trimmed, ctx.userId);
  ctx.db.updateWorkItemBody(item.id, nextBody);
  const updated = ctx.db.getWorkItem(item.id)!;

  return {
    kind: "keyboard_message",
    text: [
      `Updated item #${updated.id}.`,
      "",
      `Title: ${updated.title}`,
      `Status: ${updated.status}`,
      "",
      "Approve when ready, or send another message to amend it again.",
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `wi:${updated.id}:appv` },
        { text: "❌ Close/Reject", callback_data: `wi:${updated.id}:clse` },
      ]],
    },
  };
}
