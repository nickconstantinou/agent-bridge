/**
 * PURPOSE: Job handler for pr_lifecycle task type.
 * Pushes the agent branch, opens a draft PR via gh cli, links it to the work
 * item, creates a merge_pr approval record, and transitions the item to blocked
 * (awaiting human merge gate).
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";

type RunGit = (args: string[], cwd?: string) => string | Promise<string>;
type RunCommand = (binary: string, args: string[]) => Promise<string>;

interface PrLifecycleDeps {
  runGit: RunGit;
  runCommand: RunCommand;
  /** Remove a per-job workspace once the branch is safely on the remote. */
  cleanupWorkspace?: (dir: string) => void;
}

function parsePrNumber(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function createPrLifecycleHandler(deps: PrLifecycleDeps): JobHandler {
  const { runGit, runCommand, cleanupWorkspace } = deps;

  return async function prLifecycleHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const workItemId = typeof input.work_item_id === "number" ? input.work_item_id : null;
    const branchName = typeof input.branch_name === "string" ? input.branch_name : null;
    const repository = typeof input.repository === "string" ? input.repository : null;
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

      ctx.db.updateWorkItemStatus(workItemId, "blocked");
      if (workspaceDir && cleanupWorkspace) cleanupWorkspace(workspaceDir);

      const summary = `Existing PR refreshed with latest head (${headSha.slice(0, 7)}): ${existingPrUrl}\n\nUse /approvals to merge or close.`;
      return { summary, prUrl: existingPrUrl };
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

    // Record github link
    if (prNumber !== null) {
      ctx.db.linkGithubPr({
        work_item_id: workItemId,
        repository,
        pr_number: prNumber,
        branch_name: branchName,
      });
    }

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
