/**
 * PURPOSE: Generate robust implementation plans for approved work item candidates.
 * NEIGHBORS: src/workCallbacks.ts, src/jobExecutorLoop.ts, src/approvalHtml.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";
import { PermanentJobFailureError } from "../jobExecutor.js";
import { buildGithubWorkItemComment } from "../approvalHtml.js";
import { validateImplementationPlan } from "../implementationPlanQuality.js";
import { createRunCommand } from "../runCommandAsync.js";
import { resolveLocalRepoPath } from "../workspace.js";

type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;
type RunCommand = (binary: string, args: string[]) => Promise<string>;

interface ImplementationPlanDeps {
  runCli: RunCli;
  command?: string;
  runCommand?: RunCommand;
  resolveRepoPath?: (repository: string) => string | null;
}

export { validateImplementationPlan };

function buildPrompt(input: { title: string; body: string | null; kind: string; source: string; repository: string | null }): string {
  return `Create an implementation-ready plan for this work item.

Repository: ${input.repository ?? "(unknown)"}
Kind: ${input.kind}
Source: ${input.source}
Title: ${input.title}

Issue / context:
${input.body ?? "(none)"}

Return Markdown with exactly these sections:

## Problem Summary
Summarise the actual defect/feature/refactor in implementation terms.

## Target Files
List concrete file paths likely to change and why.

## Architectural Intent
Describe the boundary/ownership/design intent that must be preserved or changed.

## Test Plan
Name the first failing test file and assertion intent. Include focused command.

## Implementation Phases
Small red/green phases. Each phase must include test-first step, production change, verification command, and commit message.

## Acceptance Criteria
3-7 verifiable criteria.

## Verification Commands
Exact commands to run, including typecheck and tests where applicable.

## Risks / Rollback
Operational risks and rollback notes.

## Out of Scope
Explicit non-goals.

Do not implement code. Do not restate the issue without a concrete plan.`;
}

export function createImplementationPlanHandler(deps: ImplementationPlanDeps): JobHandler {
  const {
    runCli,
    command = "claude",
    runCommand = createRunCommand({ loadGhToken: true }),
    resolveRepoPath = resolveLocalRepoPath,
  } = deps;

  return async function implementationPlanHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const workItemId = typeof input.work_item_id === "number" ? input.work_item_id : null;
    if (workItemId == null) throw new Error("input.work_item_id is required");

    const item = ctx.db.getWorkItem(workItemId);
    if (!item) throw new Error(`Work item ${workItemId} not found`);

    const cwd = item.repository ? resolveRepoPath(item.repository) ?? process.cwd() : process.cwd();
    const planText = await runCli(command, ["--print", "--output-format", "text", buildPrompt(item)], cwd);
    const quality = validateImplementationPlan(planText);
    if (!quality.valid) {
      throw new PermanentJobFailureError(`Implementation plan failed quality gate: ${quality.missing.join(", ")}`);
    }

    ctx.db.setWorkItemPlan(item.id, planText, quality);

    const link = ctx.db.raw.prepare(
      `SELECT * FROM github_links WHERE work_item_id = ? AND issue_number IS NOT NULL ORDER BY id ASC LIMIT 1`,
    ).get(item.id) as { repository: string; issue_number: number } | undefined;
    if (link) {
      const comment = buildGithubWorkItemComment(ctx.db, ctx.db.getWorkItem(item.id) ?? item);
      await runCommand("gh", ["issue", "comment", String(link.issue_number), "--repo", link.repository, "--body", comment]);
    }

    return {
      summary: `Implementation plan ready for work item #${item.id}. Review the approval pack before approving.`,
      work_item_id: item.id,
      work_item_ids: [item.id],
      plan_quality: quality,
    };
  };
}
