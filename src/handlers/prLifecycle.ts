/**
 * PURPOSE: Job handler for pr_lifecycle task type.
 * Pushes the agent branch, opens a draft PR via gh cli, links it to the work
 * item, creates a merge_pr approval record, and transitions the item to blocked
 * (awaiting human merge gate).
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";
import { resolveGithubOwner } from "../repoRegistry.js";
import { PermanentJobFailureError } from "../jobExecutor.js";
import { buildGithubPrComment, buildPrApprovalPack } from "../approvalHtml.js";

type RunGit = (args: string[], cwd?: string) => string | Promise<string>;
type RunCommand = (binary: string, args: string[]) => Promise<string>;

interface PrLifecycleDeps {
  runGit: RunGit;
  runCommand: RunCommand;
  /** Deprecated: workspace cleanup happens after PR merge/close, not on PR open. */
  cleanupWorkspace?: (dir: string) => void;
  /** Maximum simultaneous open agent PRs per repository (default 3). */
  maxOpenPrs?: number;
  /** Maximum new agent PRs opened in the current UTC calendar day (default 3). */
  maxDailyPrs?: number;
}

function parsePrNumber(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function buildProofCommentBody(headSha: string, verifyOutput: string): string {
  const trimmed = verifyOutput.trim();
  const hasFail = trimmed && /fail|error/i.test(trimmed);
  const lines: string[] = [
    `<!-- agent-proof sha:${headSha} -->`,
    `**Agent proof — head \`${headSha.slice(0, 7)}\`** ${hasFail ? "⚠️ failures detected" : "✅ tests passed"}`,
    "",
    "Automated TDD implementation. Human merge approval required before squash-merge.",
  ];
  if (trimmed) {
    lines.push("", hasFail ? "**Verification output (failures detected):**" : "**Verification output:**", "```", trimmed, "```");
  }
  return lines.join("\n");
}

async function postPrApprovalPackComment(
  db: JobHandlerContext["db"],
  runCommand: RunCommand,
  workItemId: number,
  repository: string,
  prNumber: number,
): Promise<void> {
  if (!buildPrApprovalPack(db, workItemId)) return;
  try {
    await runCommand("gh", [
      "pr", "comment", String(prNumber),
      "--repo", repository,
      "--body", buildGithubPrComment(db, workItemId),
    ]);
  } catch (err) {
    console.warn("[pr-lifecycle] approval pack comment failed", err);
  }
}

function markPrCiPendingAndQueueWatch(
  db: JobHandlerContext["db"],
  linkId: number,
  prNumber: number | null,
  headSha: string,
): void {
  db.raw.prepare(
    `UPDATE github_links
     SET pr_state = 'ci_pending', commit_sha = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(headSha, linkId);

  if (prNumber != null && headSha) {
    db.createWorkJob({
      task_type: "pr_watch",
      idempotency_key: `pr_watch:pr:${prNumber}:${headSha}`,
      max_attempts: 1,
    });
  }
}

async function reconcileOpenPrStates(
  db: JobHandlerContext["db"],
  runCommand: RunCommand,
  repository: string,
): Promise<void> {
  const openPrs = db.listOpenAgentPrs(repository);
  for (const link of openPrs) {
    if (link.pr_number == null) continue;
    try {
      const output = await runCommand("gh", [
        "pr", "view", String(link.pr_number),
        "--repo", repository,
        "--json", "state",
      ]);
      const state = String((JSON.parse(output) as { state?: string }).state || "").toLowerCase();
      if (state === "closed" || state === "merged") {
        db.updatePrState(link.id, state);
      }
    } catch {
      // Reconciliation is best-effort; leave local state intact on gh failures.
    }
  }
}

export function createPrLifecycleHandler(deps: PrLifecycleDeps): JobHandler {
  const { runGit, runCommand, maxOpenPrs = 3, maxDailyPrs = 3 } = deps;

  return async function prLifecycleHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const workItemId = typeof input.work_item_id === "number" ? input.work_item_id : null;
    const branchName = typeof input.branch_name === "string" ? input.branch_name : null;
    const rawRepository = typeof input.repository === "string" ? input.repository : null;
    const repository = rawRepository && !rawRepository.includes("/") ? `${resolveGithubOwner()}/${rawRepository}` : rawRepository;
    const repoPath = typeof input.repository_path === "string" ? input.repository_path : undefined;

    if (workItemId === null) throw new Error("input.work_item_id is required");
    if (!branchName) throw new Error("input.branch_name is required");
    if (!repository) throw new Error("input.repository is required");

    const item = ctx.db.getWorkItem(workItemId);
    if (!item) throw new Error(`Work item ${workItemId} not found`);

    // Push branch to origin
    await runGit(["push", "--set-upstream", "origin", branchName], repoPath);

    // Capture the head SHA so the merge gate can detect a moved head later
    const headSha = (await runGit(["rev-parse", "HEAD"], repoPath)).trim();

    // ── Owner decision brief ──────────────────────────────────────────────────
    let commit_subjects: string[] | undefined;
    let files_summary: string | undefined;
    const verify_tail = typeof input.verify_output === "string" && input.verify_output
      ? input.verify_output.slice(-500)
      : undefined;

    const branchRange = "origin/main..HEAD";

    try {
      const logOut = String(await runGit(["log", "--format=%s", branchRange], repoPath));
      const subjects = logOut.split("\n").map(s => s.trim()).filter(Boolean);
      if (subjects.length) commit_subjects = subjects;
    } catch {}

    try {
      const diffOut = String(await runGit(["diff", "--stat", branchRange], repoPath));
      if (diffOut.trim()) files_summary = diffOut;
    } catch {}

    // ── Idempotent: reuse an existing PR rather than opening a second one ───────
    const existingLink = ctx.db.raw
      .prepare("SELECT * FROM github_links WHERE repository = ? AND branch_name = ?")
      .get(repository, branchName) as { id: number; pr_number: number; proof_comment_sha?: string | null } | undefined;

    if (existingLink) {
      const existingPrUrl = `https://github.com/${repository}/pull/${existingLink.pr_number}`;
      markPrCiPendingAndQueueWatch(ctx.db, existingLink.id, existingLink.pr_number, headSha);

      // Post a new proof comment only if the head SHA has changed (idempotent)
      if (existingLink.proof_comment_sha !== headSha && existingLink.pr_number !== null) {
        const verifyText = typeof input.verify_output === "string" ? input.verify_output.slice(-500) : "";
        const commentBody = buildProofCommentBody(headSha, verifyText);
        try {
          await runCommand("gh", ["pr", "comment", String(existingLink.pr_number), "--repo", repository, "--body", commentBody]);
          ctx.db.setProofCommentSha(existingLink.id, headSha);
        } catch {}
        await postPrApprovalPackComment(ctx.db, runCommand, workItemId, repository, existingLink.pr_number);
      }

      ctx.db.updateWorkItemStatus(workItemId, "blocked");
      const summary = `Existing PR refreshed with latest head (${headSha.slice(0, 7)}): ${existingPrUrl}\n\nCI watch queued; merge approval will be created after GitHub checks pass.`;
      return { summary, prUrl: existingPrUrl, work_item_id: workItemId, work_item_ids: [workItemId] };
    }

    // ── PR caps — only applies to new PR creation ────────────────────────────
    await reconcileOpenPrStates(ctx.db, runCommand, repository);
    const openPrs = ctx.db.listOpenAgentPrs(repository);
    if (openPrs.length >= maxOpenPrs) {
      const list = openPrs.map(l => `#${l.pr_number}`).join(", ");
      throw new PermanentJobFailureError(
        `Open PR cap reached (${openPrs.length}/${maxOpenPrs}) for ${repository}. ` +
        `Open PRs blocking the slot: ${list}. Merge or close existing PRs before opening new ones.`
      );
    }
    const dailyCount = ctx.db.countDailyAgentPrs(repository);
    if (dailyCount >= maxDailyPrs) {
      throw new PermanentJobFailureError(
        `Daily PR cap reached (${dailyCount}/${maxDailyPrs}) for ${repository}. ` +
        `No more agent PRs will be opened today. Try again tomorrow.`
      );
    }

    // Open draft PR
    const prTitle = `[agent] ${item.title}`;

    // Linked GitHub issue, if any
    const issueLink = ctx.db.raw.prepare(
      `SELECT repository, issue_number FROM github_links WHERE work_item_id = ? AND issue_number IS NOT NULL LIMIT 1`
    ).get(workItemId) as { repository: string; issue_number: number } | undefined;

    const prBodyParts: string[] = [];
    prBodyParts.push(`## Summary`);
    prBodyParts.push(`Automated TDD implementation — work item **#${workItemId}**.`);
    if (issueLink) {
      prBodyParts.push(`Closes https://github.com/${issueLink.repository}/issues/${issueLink.issue_number}`);
    }
    prBodyParts.push("");

    if (commit_subjects?.length) {
      prBodyParts.push("## Commits");
      commit_subjects.forEach(s => prBodyParts.push(`- ${s}`));
      prBodyParts.push("");
    }

    if (files_summary) {
      prBodyParts.push("## Files changed");
      prBodyParts.push("```");
      prBodyParts.push(files_summary.trim().slice(0, 1500));
      prBodyParts.push("```");
      prBodyParts.push("");
    }

    if (item.body) {
      prBodyParts.push("## Implementation plan");
      prBodyParts.push(item.body.slice(0, 3000));
      prBodyParts.push("");
    }

    if (verify_tail) {
      const failed = /fail|error/i.test(verify_tail);
      prBodyParts.push(`## Verification ${failed ? "⚠️ (see failures below)" : "✅"}`);
      prBodyParts.push("```");
      prBodyParts.push(verify_tail.trim());
      prBodyParts.push("```");
      prBodyParts.push("");
    }

    prBodyParts.push("---");
    prBodyParts.push("_Opened automatically by the agent bridge. Human merge approval required._");

    const prBody = prBodyParts.join("\n").trim();

    const prArgs = [
      "pr", "create",
      "--repo", repository,
      "--title", prTitle,
      "--body", prBody.slice(0, 4000),
      "--draft",
      "--head", branchName,
    ];

    let prUrl: string;
    let prNumber: number | null;

    try {
      const prOutput = await runCommand("gh", prArgs);
      prUrl = prOutput.trim().split("\n").pop()?.trim() ?? prOutput.trim();
      prNumber = parsePrNumber(prUrl);
    } catch (err) {
      // gh pr create reports "already exists" — recover by parsing the URL from the error
      const msg = err instanceof Error ? err.message : String(err);
      const m = msg.match(/already exists[:\s\n]*(https:\/\/github\.com\/[^\s]+\/pull\/(\d+))/i);
      if (!m) throw err;
      prUrl = m[1];
      prNumber = Number(m[2]);
    }

    // Record github link and post proof comment
    if (prNumber !== null) {
      const newLink = ctx.db.linkGithubPr({
        work_item_id: workItemId,
        repository,
        pr_number: prNumber,
        branch_name: branchName,
        commit_sha: headSha,
      });
      markPrCiPendingAndQueueWatch(ctx.db, newLink.id, prNumber, headSha);
      const verifyText = typeof input.verify_output === "string" ? input.verify_output.slice(-500) : "";
      const commentBody = buildProofCommentBody(headSha, verifyText);
      try {
        await runCommand("gh", ["pr", "comment", String(prNumber), "--repo", repository, "--body", commentBody]);
        ctx.db.setProofCommentSha(newLink.id, headSha);
      } catch {}
      await postPrApprovalPackComment(ctx.db, runCommand, workItemId, repository, prNumber);
    }

    // Transition item to blocked — awaiting CI watch and then human merge gate
    ctx.db.updateWorkItemStatus(workItemId, "blocked");

    const summary = `Draft PR opened: ${prUrl}\n\nCI watch queued; merge approval will be created after GitHub checks pass.`;
    return { summary, prUrl, work_item_id: workItemId, work_item_ids: [workItemId] };
  };
}
