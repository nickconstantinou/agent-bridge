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

    const prOutput = await runCommand("gh", prArgs);
    const prUrl = prOutput.trim().split("\n").pop()?.trim() ?? prOutput.trim();
    const prNumber = parsePrNumber(prUrl);

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
    const workspaceDir = typeof input.workspace_dir === "string" ? input.workspace_dir : null;
    if (workspaceDir && cleanupWorkspace) cleanupWorkspace(workspaceDir);

    const summary = `Draft PR opened: ${prUrl}\n\nUse the inline keyboard or /approvals to merge or close.`;
    return { summary, prUrl };
  };
}
