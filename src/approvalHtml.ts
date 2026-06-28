/**
 * PURPOSE: Build escaped HTML approval packs for worker-bot review before action.
 * NEIGHBORS: src/workCallbacks.ts, src/prMergeGate.ts, src/telegram.ts
 */

import type { BridgeDb, WorkItem, WorkJob, Approval, GithubLink } from "./db.js";

export interface ApprovalHtmlPack {
  filename: string;
  caption: string;
  html: string;
}

export const APPROVAL_PACK_COMMENT_MARKER = "<!-- agent-bridge:approval-pack:v1 -->";
const MAX_GITHUB_COMMENT_CHARS = 60_000;
const MAX_PRE_CHARS = 18_000;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function truncate(value: string, max = MAX_PRE_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}\n\n[truncated]` : value;
}

function prettyJson(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function row(label: string, value: unknown): string {
  const display = value === null || value === undefined || value === "" ? "none" : value;
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(display)}</td></tr>`;
}

function section(title: string, body: string): string {
  if (!body.trim()) return "";
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function pre(value: unknown): string {
  const text = truncate(prettyJson(value));
  if (!text.trim()) return "";
  return `<pre>${escapeHtml(text)}</pre>`;
}

function itemLabel(item: WorkItem): string {
  if (item.kind === "feature") return "Feature Work Item";
  if (item.kind === "refactor" || item.source === "refactor_scan") return "Refactor Work Item";
  if (item.source === "defect_scan") return "Review Work Item";
  return "Work Item";
}

function shell(title: string, subtitle: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; color: #172026; background: #f6f8fa; }
    main { max-width: 980px; margin: 0 auto; padding: 28px 20px 48px; }
    header { border-bottom: 2px solid #d0d7de; margin-bottom: 20px; padding-bottom: 14px; }
    h1 { margin: 0 0 4px; font-size: 28px; line-height: 1.15; }
    h2 { margin: 28px 0 10px; font-size: 18px; }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    th, td { border: 1px solid #d0d7de; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { width: 190px; background: #f0f3f6; font-weight: 650; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #fff; border: 1px solid #d0d7de; padding: 12px; border-radius: 6px; }
    .muted { color: #57606a; }
    @media (prefers-color-scheme: dark) {
      body { color: #d8dee4; background: #0d1117; }
      header { border-color: #30363d; }
      table, pre { background: #161b22; }
      th, td, pre { border-color: #30363d; }
      th { background: #21262d; }
      .muted { color: #8b949e; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(title)}</h1>
      <div class="muted">${escapeHtml(subtitle)}</div>
    </header>
    ${body}
  </main>
</body>
</html>`;
}

function getRows<T>(db: BridgeDb, sql: string, ...params: unknown[]): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

export function buildWorkItemApprovalPack(db: BridgeDb, item: WorkItem): ApprovalHtmlPack {
  const jobs = getRows<WorkJob>(db, "SELECT * FROM work_jobs WHERE work_item_id = ? ORDER BY id ASC", item.id);
  const approvals = getRows<Approval>(db, "SELECT * FROM approvals WHERE work_item_id = ? ORDER BY id ASC", item.id);
  const links = getRows<GithubLink>(db, "SELECT * FROM github_links WHERE work_item_id = ? ORDER BY id ASC", item.id);
  const label = itemLabel(item);

  const metadata = `<table>${[
    row("ID", item.id),
    row("Kind", item.kind),
    row("Source", item.source),
    row("Repository", item.repository),
    row("Status", item.status),
    row("Priority", item.priority),
    row("Created by", item.created_by),
    row("Created at", item.created_at),
    row("Updated at", item.updated_at),
  ].join("")}</table>`;

  const jobsBody = jobs.length === 0 ? "<p>No linked jobs yet.</p>" : `<table>${jobs.map(job => [
    row("Job ID", job.id),
    row("Task", job.task_type),
    row("Status", job.status),
    row("Attempts", `${job.attempt_count}/${job.max_attempts}`),
    row("Bot", job.bot),
    row("Error", job.error),
  ].join("")).join("")}</table>`;

  const approvalsBody = approvals.length === 0 ? "<p>No linked approvals yet.</p>" : `<table>${approvals.map(appr => [
    row("Approval ID", appr.id),
    row("Type", appr.approval_type),
    row("Status", appr.status),
    row("Requested by", appr.requested_by),
    row("Requested at", appr.requested_at),
    row("Payload", prettyJson(parseJson(appr.payload_json))),
  ].join("")).join("")}</table>`;

  const linksBody = links.length === 0 ? "<p>No GitHub links yet.</p>" : `<table>${links.map(link => [
    row("Repository", link.repository),
    row("Issue", link.issue_number),
    row("PR", link.pr_number),
    row("Branch", link.branch_name),
    row("Commit", link.commit_sha),
    row("State", (link as any).pr_state),
  ].join("")).join("")}</table>`;

  const html = shell(
    `${label} #${item.id}: ${item.title}`,
    "Review this pack before approving, rejecting, merging, or closing.",
    [
      section("Summary", metadata),
      section("Title", `<p>${escapeHtml(item.title)}</p>`),
      section(item.kind === "feature" ? "Implementation Plan" : "Work Item Body", pre(item.body)),
      section("Linked Jobs", jobsBody),
      section("Approvals", approvalsBody),
      section("GitHub", linksBody),
    ].join("\n"),
  );

  return {
    filename: `work-item-${item.id}.html`,
    caption: `${label} #${item.id} approval pack`,
    html,
  };
}

export function buildPrApprovalPack(db: BridgeDb, workItemId: number): ApprovalHtmlPack | null {
  const item = db.getWorkItem(workItemId);
  if (!item) return null;
  const approval = db.raw.prepare(
    "SELECT * FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr' AND status = 'pending' ORDER BY id DESC LIMIT 1",
  ).get(workItemId) as Approval | undefined;
  const link = db.raw.prepare(
    "SELECT * FROM github_links WHERE work_item_id = ? AND pr_number IS NOT NULL ORDER BY id DESC LIMIT 1",
  ).get(workItemId) as GithubLink | undefined;
  const payload = parseJson(approval?.payload_json);

  const metadata = `<table>${[
    row("Work item", `#${item.id}`),
    row("Repository", link?.repository ?? item.repository),
    row("PR number", link?.pr_number ?? (payload as any)?.pr_number),
    row("PR URL", (payload as any)?.pr_url),
    row("Branch", link?.branch_name ?? (payload as any)?.branch_name),
    row("Head SHA", (payload as any)?.head_sha ?? link?.commit_sha),
    row("PR state", (link as any)?.pr_state),
    row("Approval ID", approval?.id),
    row("Approval status", approval?.status),
  ].join("")}</table>`;

  const html = shell(
    `PR Approval Pack for Work Item #${item.id}`,
    "Review pull request details before merge or close approval.",
    [
      section("PR Summary", metadata),
      section("Work Item", `<table>${[
        row("Kind", item.kind),
        row("Source", item.source),
        row("Title", item.title),
        row("Status", item.status),
        row("Priority", item.priority),
      ].join("")}</table>`),
      section("Work Item Body", pre(item.body)),
      section("Approval Payload", pre(payload)),
    ].join("\n"),
  );

  return {
    filename: `pr-${link?.pr_number ?? item.id}.html`,
    caption: `PR approval pack for work item #${item.id}`,
    html,
  };
}

export async function sendApprovalHtmlPack(client: any, chatId: number, pack: ApprovalHtmlPack): Promise<boolean> {
  if (typeof client.sendDocumentBuffer !== "function") return false;
  await client.sendDocumentBuffer({
    chat_id: chatId,
    filename: pack.filename,
    bytes: Buffer.from(pack.html, "utf8"),
    mime_type: "text/html",
    caption: pack.caption,
  });
  return true;
}

function mdTable(rows: Array<[string, string]>): string {
  return `| Field | Value |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v || "—"} |`).join("\n")}`;
}

function mdTruncate(text: string, max = MAX_GITHUB_COMMENT_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 40)}\n\n[truncated — full pack sent to Telegram]` : text;
}

function planSectionLabel(item: WorkItem): string {
  if (item.kind === "feature") return "Implementation Plan";
  if (item.source === "defect_scan") return "Defect Findings";
  if (item.source === "refactor_scan") return "Refactor Findings";
  if (item.source === "github") return "Issue Description";
  return "Plan / Context";
}

export function buildGithubWorkItemComment(db: BridgeDb, item: WorkItem): string {
  const jobs = getRows<WorkJob>(db, "SELECT * FROM work_jobs WHERE work_item_id = ? ORDER BY id DESC LIMIT 10", item.id);
  const links = getRows<GithubLink>(db, "SELECT * FROM github_links WHERE work_item_id = ? ORDER BY id ASC", item.id);
  const label = itemLabel(item);

  const meta = mdTable([
    ["Kind", item.kind],
    ["Source", item.source],
    ["Repository", item.repository ?? ""],
    ["Status", item.status],
    ["Priority", item.priority ?? "normal"],
  ]);

  const planLabel = planSectionLabel(item);
  const planBody = item.body?.trim() ? `### ${planLabel}\n\n${item.body.trim()}` : "";

  const jobRows = jobs.map(j => `| ${j.id} | ${j.task_type} | ${j.status} | ${j.bot ?? "—"} |`).join("\n");
  const jobsSection = jobs.length > 0
    ? `### Linked Jobs\n\n| ID | Type | Status | Bot |\n|---|---|---|---|\n${jobRows}`
    : "";

  const linkRows = links.map(l => `| ${l.repository} | ${l.issue_number ?? "—"} | ${l.pr_number ?? "—"} | ${l.branch_name ?? "—"} |`).join("\n");
  const linksSection = links.length > 0
    ? `### GitHub Links\n\n| Repo | Issue | PR | Branch |\n|---|---|---|---|\n${linkRows}`
    : "";

  const parts = [
    APPROVAL_PACK_COMMENT_MARKER,
    `## ${label} #${item.id}: ${item.title}`,
    "",
    meta,
    "",
    planBody,
    "",
    jobsSection,
    "",
    linksSection,
    "",
    "---",
    "*Pending approval via Telegram.*",
  ].filter(Boolean).join("\n");

  return mdTruncate(parts);
}

export function buildGithubPrComment(db: BridgeDb, workItemId: number): string {
  const item = db.getWorkItem(workItemId);
  if (!item) return `${APPROVAL_PACK_COMMENT_MARKER}\n\n*Work item #${workItemId} not found.*`;

  const approval = db.raw.prepare(
    "SELECT * FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr' AND status = 'pending' ORDER BY id DESC LIMIT 1",
  ).get(workItemId) as Approval | undefined;
  const link = db.raw.prepare(
    "SELECT * FROM github_links WHERE work_item_id = ? AND pr_number IS NOT NULL ORDER BY id DESC LIMIT 1",
  ).get(workItemId) as GithubLink | undefined;
  const payload = parseJson(approval?.payload_json) as Record<string, unknown> | null;

  const meta = mdTable([
    ["Work item", `#${item.id}`],
    ["Kind", item.kind],
    ["Repository", link?.repository ?? item.repository ?? ""],
    ["PR number", String(link?.pr_number ?? payload?.pr_number ?? "")],
    ["PR URL", String(payload?.pr_url ?? "")],
    ["Branch", String(link?.branch_name ?? payload?.branch_name ?? "")],
    ["Head SHA", String(payload?.head_sha ?? link?.commit_sha ?? "")],
  ]);

  const parts = [
    APPROVAL_PACK_COMMENT_MARKER,
    `## PR Approval — Work Item #${item.id}: ${item.title}`,
    "",
    meta,
    "",
    item.body?.trim() ? `### Implementation Plan\n\n${item.body.trim()}` : "",
    "",
    "---",
    "*Merge or close via Telegram bot.*",
  ].filter(Boolean).join("\n");

  return mdTruncate(parts);
}

/** @deprecated Use buildGithubWorkItemComment or buildGithubPrComment instead. */
export function buildGithubApprovalPackComment(pack: ApprovalHtmlPack): string {
  return `${APPROVAL_PACK_COMMENT_MARKER}\n\n## ${pack.caption}\n\n*Full approval pack sent to Telegram.*`;
}
