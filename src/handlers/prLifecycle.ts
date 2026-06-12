/**
 * PURPOSE: Job handler for pr_lifecycle task type.
 * Pushes the agent branch, opens a draft PR via gh cli, links it to the work
 * item, creates a merge_pr approval record, and transitions the item to blocked
 * (awaiting human merge gate).
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";
import { PermanentJobFailureError } from "../jobExecutor.js";

type RunGit = (args: string[], cwd?: string) => string | Promise<string>;
type RunCommand = (binary: string, args: string[]) => Promise<string>;

interface PrLifecycleDeps {
  runGit: RunGit;
  runCommand: RunCommand;
  /** Remove a per-job workspace once the branch is safely on the remote. */
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
  const lines: string[] = [
    `<!-- agent-proof sha:${headSha} -->`,
    `**Agent proof — head \`${headSha.slice(0, 7)}\`**`,
    "",
    "Automated TDD implementation. All tests passed before this PR was opened.",
    "Human merge approval required before squash-merge.",
  ];
  if (verifyOutput.trim()) {
    lines.push("", "**Verification output:**", "```", verifyOutput.trim(), "```");
  }
  return lines.join("\n");
}

export function createPrLifecycleHandler(deps: PrLifecycleDeps): JobHandler {
  const { runGit, runCommand, cleanupWorkspace, maxOpenPrs = 3, maxDailyPrs = 3 } = deps;

  return async function prLifecycleHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const workItemId = typeof input.work_item_id === "number" ? input.work_item_id : null;
    const branchName = typeof input.branch_name === "string" ? input.branch_name : null;
    const rawRepository = typeof input.repository === "string" ? input.repository : null;
    const repository = rawRepository && !rawRepository.includes("/") ? `nickconstantinou/${rawRepository}` : rawRepository;
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

    const workspaceDir = typeof input.workspace_dir === "string" ? input.workspace_dir : null;

    // ── Idempotent: reuse an existing PR rather than opening a second one ───────
    const existingLink = ctx.db.raw
      .prepare("SELECT * FROM github_links WHERE repository = ? AND branch_name = ?")
      .get(repository, branchName) as { id: number; pr_number: number } | undefined;

    if (existingLink) {
      const existingPrUrl = `https://github.com/${repository}/pull/${existingLink.pr_number}`;

      // Refresh head_sha in any pending merge_pr approval for this work item
      const pendingApproval = ctx.db.raw
        .prepare(
          "SELECT id, payload_json FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr' AND status = 'pending'"
        )
        .get(workItemId) as { id: number; payload_json: string } | undefined;

      if (pendingApproval) {
        const payload = JSON.parse(pendingApproval.payload_json);
        payload.head_sha = headSha;
        ctx.db.raw
          .prepare("UPDATE approvals SET payload_json = ? WHERE id = ?")
          .run(JSON.stringify(payload), pendingApproval.id);
      }

      // Post a new proof comment only if the head SHA has changed (idempotent)
      if (existingLink.proof_comment_sha !== headSha && existingLink.pr_number !== null) {
        const verifyText = typeof input.verify_output === "string" ? input.verify_output.slice(-500) : "";
        const commentBody = buildProofCommentBody(headSha, verifyText);
        try {
          await runCommand("gh", ["pr", "comment", String(existingLink.pr_number), "--repo", repository, "--body", commentBody]);
          ctx.db.setProofCommentSha(existingLink.id, headSha);
        } catch {}
      }

      ctx.db.updateWorkItemStatus(workItemId, "blocked");
      if (workspaceDir && cleanupWorkspace) cleanupWorkspace(workspaceDir);

      const summary = `Existing PR refreshed with latest head (${headSha.slice(0, 7)}): ${existingPrUrl}\n\nUse /approvals to merge or close.`;
      return { summary, prUrl: existingPrUrl };
    }

    // ── PR caps — only applies to new PR creation ────────────────────────────
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
    const prBody = [
      `Work item #${workItemId}`,
      "",
      item.body ?? "",
      "",
      "---",
      "_Opened automatically by the agent bridge. Human merge approval required._",
    ].join("\n").trim();

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
      });
      const verifyText = typeof input.verify_output === "string" ? input.verify_output.slice(-500) : "";
      const commentBody = buildProofCommentBody(headSha, verifyText);
      try {
        await runCommand("gh", ["pr", "comment", String(prNumber), "--repo", repository, "--body", commentBody]);
        ctx.db.setProofCommentSha(newLink.id, headSha);
      } catch {}
    }

    // ── Owner decision brief ──────────────────────────────────────────────────
    let commit_subjects: string[] | undefined;
    let files_summary: string | undefined;
    const verify_tail = typeof input.verify_output === "string" && input.verify_output
      ? input.verify_output.slice(-500)
      : undefined;

    try {
      const logOut = String(await runGit(["log", "--format=%s", "-10", "HEAD"], repoPath));
      const subjects = logOut.split("\n").map(s => s.trim()).filter(Boolean);
      if (subjects.length) commit_subjects = subjects;
    } catch {}

    try {
      const diffOut = String(await runGit(["diff", "--stat"], repoPath));
      if (diffOut.trim()) files_summary = diffOut;
    } catch {}

    // Create merge_pr approval record
    ctx.db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: workItemId,
      payload: {
        pr_url: prUrl,
        pr_number: prNumber,
        branch_name: branchName,
        repository,
        ...(headSha ? { head_sha: headSha } : {}),
        ...(commit_subjects ? { commit_subjects } : {}),
        ...(files_summary ? { files_summary } : {}),
        ...(verify_tail ? { verify_tail } : {}),
      },
    });

    // Transition item to blocked — awaiting human merge gate
    ctx.db.updateWorkItemStatus(workItemId, "blocked");

    // Branch is on the remote — the per-job workspace has served its purpose
    if (workspaceDir && cleanupWorkspace) cleanupWorkspace(workspaceDir);

    const summary = `Draft PR opened: ${prUrl}\n\nUse the inline keyboard or /approvals to merge or close.`;
    return { summary, prUrl };
  };
}
