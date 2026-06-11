/**
 * PURPOSE: Job handler for pr_refresh task type.
 * In a workspace clone: fetches origin, merges base branch (never rebases —
 * never rewrite pushed history without approval), runs tests, and pushes if
 * clean. On merge conflict or failing tests: marks ci_failed, does not push.
 * NEIGHBORS: src/db.ts, src/jobExecutor.ts, src/workspace.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";

type RunGit = (args: string[], cwd?: string) => string | Promise<string>;
type RunCommand = (binary: string, args: string[]) => Promise<string>;
type RunTests = (cwd: string) => Promise<{ ok: boolean; output: string }>;

interface PrRefreshDeps {
  runGit: RunGit;
  runCommand: RunCommand;
  runTests: RunTests;
  prepareWorkspace?: (repository: string, workItemId: number) => Promise<string>;
  cleanupWorkspace?: (dir: string) => void;
}

export function createPrRefreshHandler(deps: PrRefreshDeps): JobHandler {
  const { runGit, runTests, cleanupWorkspace } = deps;

  return async function prRefreshHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const workItemId = typeof input.work_item_id === "number" ? input.work_item_id : null;
    const repository = typeof input.repository === "string" ? input.repository : null;
    const branchName = typeof input.branch_name === "string" ? input.branch_name : null;
    const baseBranch = typeof input.base_branch === "string" ? input.base_branch : "main";
    const repoPath = typeof input.repository_path === "string"
      ? input.repository_path
      : typeof input.workspace_dir === "string" ? input.workspace_dir : undefined;
    const workspaceDir = typeof input.workspace_dir === "string" ? input.workspace_dir : null;

    if (workItemId === null) throw new Error("input.work_item_id is required");
    if (!repository) throw new Error("input.repository is required");
    if (!branchName) throw new Error("input.branch_name is required");

    const item = ctx.db.getWorkItem(workItemId);
    if (!item) throw new Error(`Work item ${workItemId} not found`);

    // Fetch latest origin state
    await runGit(["fetch", "origin"], repoPath);

    // Find the github_link for this branch so we can update its state
    const link = ctx.db.raw
      .prepare("SELECT * FROM github_links WHERE repository = ? AND branch_name = ?")
      .get(repository, branchName) as { id: number; pr_number: number } | undefined;

    // Attempt merge (not rebase — never rewrite pushed history without approval)
    try {
      await runGit(["merge", `origin/${baseBranch}`, "--no-edit"], repoPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Leave workspace in place for human inspection
      if (link) ctx.db.updatePrState(link.id, "ci_failed");
      return {
        summary: `Merge conflict merging ${baseBranch} into ${branchName}: ${msg.slice(0, 300)}.\nWorkspace preserved for manual resolution.`,
        error: msg,
      };
    }

    // Run tests
    const { ok, output } = await runTests(repoPath ?? ".");
    if (!ok) {
      if (link) ctx.db.updatePrState(link.id, "ci_failed");
      return {
        summary: `Tests failed after merging ${baseBranch}. Branch NOT pushed.\n\n${output.slice(0, 500)}`,
        error: output,
      };
    }

    // Capture new head SHA
    const headSha = (await runGit(["rev-parse", "HEAD"], repoPath)).trim();

    // Push (never force)
    await runGit(["push", "origin", branchName], repoPath);

    // Update the pending merge approval head SHA
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

    // Reset PR state to draft so pr_watch re-evaluates CI readiness
    if (link) ctx.db.updatePrState(link.id, "draft");

    if (workspaceDir && cleanupWorkspace) cleanupWorkspace(workspaceDir);

    return {
      summary: `Branch ${branchName} refreshed from ${baseBranch} (${headSha.slice(0, 7)}), tests passed, pushed.`,
    };
  };
}
