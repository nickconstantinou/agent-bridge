/**
 * PURPOSE: Job handler for open_github_issue task type.
 * Runs `gh issue create` via an args-array wrapper (no shell interpolation),
 * stores the resulting issue link, and transitions the work_item to in_progress.
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";
import { resolveGithubOwner } from "../repoRegistry.js";
import { buildGithubApprovalPackComment, buildWorkItemApprovalPack } from "../approvalHtml.js";

// Accepts an args array — no shell involved, no injection surface.
type RunCommand = (binary: string, args: string[]) => Promise<string>;

interface GithubIssueHandlerDeps {
  runCommand: RunCommand;
}

function parseIssueNumber(url: string): number | null {
  const match = url.trim().match(/\/issues\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function createGithubIssueHandler(deps: GithubIssueHandlerDeps): JobHandler {
  const { runCommand } = deps;

  return async function githubIssueHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const workItemId = typeof input.work_item_id === "number" ? input.work_item_id : null;
    const rawRepository = typeof input.repository === "string" ? input.repository : null;
    const repository = rawRepository && !rawRepository.includes("/") ? `${resolveGithubOwner()}/${rawRepository}` : rawRepository;

    if (workItemId === null) throw new Error("input.work_item_id is required");
    if (!repository) throw new Error("input.repository is required");

    const item = ctx.db.getWorkItem(workItemId);
    if (!item) throw new Error(`Work item ${workItemId} not found`);

    const labels = ["agent-proposed"];
    if (item.kind === "defect") labels.push("bug");
    if (item.kind === "feature") labels.push("enhancement");

    const args = [
      "issue", "create",
      "--repo", repository,
      "--title", item.title,
      "--body", (item.body ?? "").slice(0, 4000),
      "--label", labels.join(","),
    ];

    const output = await runCommand("gh", args);
    const url = output.trim();

    if (!url || !url.includes("/issues/")) {
      throw new Error(`gh issue create did not return a valid issue URL: "${url}"`);
    }

    const issueNumber = parseIssueNumber(url);
    if (issueNumber !== null) {
      ctx.db.linkGithubIssue({ work_item_id: workItemId, repository, issue_number: issueNumber });
      const pack = buildWorkItemApprovalPack(ctx.db, ctx.db.getWorkItem(workItemId) ?? item);
      const comment = buildGithubApprovalPackComment(pack);
      try {
        await runCommand("gh", ["issue", "comment", String(issueNumber), "--repo", repository, "--body", comment]);
      } catch (err) {
        console.warn("[github-issue] approval pack comment failed", err);
      }
    }

    ctx.db.updateWorkItemStatus(workItemId, "in_progress");

    return { summary: `GitHub issue created: ${url}`, issueUrl: url };
  };
}
