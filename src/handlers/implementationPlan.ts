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
import type { WorkItem } from "../db.js";

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
  return `Create a highly detailed, concrete, implementation-ready plan for this work item. The plan must be actionable enough that an autonomous agent can execute it without further clarification.

Repository: ${input.repository ?? "(unknown)"}
Kind: ${input.kind}
Source: ${input.source}
Title: ${input.title}

Issue / context:
${input.body ?? "(none)"}

Return Markdown with exactly these sections:

## Problem Summary
Detailed analysis of the defect/feature/refactor. Reference existing behavior, file relations, and why the current design/behavior needs modification.

## Target Files
List concrete, absolute (or repo-relative) file paths that will be created or modified. For each file, specify:
- Exact classes, methods, or interfaces to be modified or added.
- The role of this file in the solution.

## Architectural Intent
Explain the design principles, boundary conditions, and ownership patterns to preserve or introduce.
Specify:
- Which component owns what state/responsibility.
- How to avoid leaking test-only code/imports into production.
- If refactoring, define the before/after ownership boundary clearly.

## Test Plan
Detailed plan for writing failing tests first:
- The exact test file path to create or modify.
- The assertion logic, test cases, and inputs/outputs to cover.
- The exact command to run the new test and verify failure.
- A skeleton code snippet of the proposed test.

## Implementation Phases
Provide a sequential, step-by-step execution roadmap. Break the work down into small red/green iterations (TDD phases).
For each phase, specify:
- Test changes (what test is added/modified).
- Production changes (what files/classes/functions are changed).
- Exact verification command to run.
- Git commit message for this phase (separate test/implementation commits).

## Acceptance Criteria
A list of 5-8 concrete, verifiable, and binary (yes/no) criteria that the implementation must meet.
Include:
- Functional criteria.
- Non-functional criteria (performance, security, error handling).
- Architectural constraints (e.g. delegation, no test leak).

## Verification Commands
A list of exact, copy-pasteable shell commands to run at the end of implementation to verify correctness (e.g. linting, typechecking, full test suite execution, coverage).

## Risks / Rollback
Potential side effects, backwards compatibility concerns, dependency updates, and recovery/rollback procedure.

## Out of Scope
Explicitly list non-goals and things the implementation must NOT do.

Do not implement code. Do not restate the issue without a concrete plan.`;
}

function buildImprovePrompt(planText: string, missing: string[]): string {
  return `Improve this implementation plan so it is concrete enough for autonomous TDD execution.

Missing or weak sections:
${missing.map(m => `- ${m}`).join("\n")}

Current plan:
${planText}

Return a complete replacement plan in Markdown with these sections:

## Problem Summary
## Target Files
## Architectural Intent
## Test Plan
## Implementation Phases
## Acceptance Criteria
## Verification Commands
## Risks / Rollback
## Out of Scope`;
}

function hasLinkedIssue(ctx: JobHandlerContext, workItemId: number): boolean {
  return (ctx.db.raw.prepare(
    `SELECT 1 FROM github_links WHERE work_item_id = ? AND issue_number IS NOT NULL LIMIT 1`,
  ).get(workItemId) as { 1: number } | undefined) != null;
}

function notifyFields(input: JobHandlerInput): Record<string, number> {
  return {
    ...(typeof input.notify_chat_id === "number" ? { notify_chat_id: input.notify_chat_id } : {}),
    ...(typeof input.notify_thread_id === "number" ? { notify_thread_id: input.notify_thread_id } : {}),
  };
}

function enqueuePostPlanImplementation(ctx: JobHandlerContext, workItemId: number, repository: string | null, input: JobHandlerInput): void {
  ctx.db.updateWorkItemStatus(workItemId, "approved");
  if (repository && !hasLinkedIssue(ctx, workItemId)) {
    ctx.db.createWorkJob({
      task_type: "open_github_issue",
      idempotency_key: `gh_issue:${workItemId}`,
      work_item_id: workItemId,
      input_json: {
        work_item_id: workItemId,
        repository,
        ...notifyFields(input),
      },
    });
  }
  ctx.db.createWorkJob({
    task_type: "tdd_implementation",
    idempotency_key: `tdd:${workItemId}`,
    work_item_id: workItemId,
    input_json: {
      work_item_id: workItemId,
      ...(repository ? { repository } : {}),
      ...notifyFields(input),
    },
  });
}

async function refreshFromLinkedGithubIssue(
  item: WorkItem,
  ctx: JobHandlerContext,
  runCommand: RunCommand,
): Promise<WorkItem> {
  const link = ctx.db.raw.prepare(
    `SELECT * FROM github_links WHERE work_item_id = ? AND issue_number IS NOT NULL ORDER BY id ASC LIMIT 1`,
  ).get(item.id) as { repository: string; issue_number: number } | undefined;
  if (!link) return item;

  const raw = await runCommand("gh", [
    "issue", "view", String(link.issue_number),
    "--repo", link.repository,
    "--json", "title,body,state",
  ]);
  const parsed = JSON.parse(raw) as { title?: string; body?: string | null; state?: string };
  if (parsed.state && parsed.state.toUpperCase() === "CLOSED") {
    throw new PermanentJobFailureError(`Linked GitHub issue #${link.issue_number} in ${link.repository} is closed`);
  }
  const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title : item.title;
  const body = typeof parsed.body === "string" ? parsed.body : item.body;
  ctx.db.updateWorkItemTitleAndBody(item.id, title, body);
  return ctx.db.getWorkItem(item.id) ?? { ...item, title, body };
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
    const canonicalItem = await refreshFromLinkedGithubIssue(item, ctx, runCommand);

    const cwd = canonicalItem.repository ? resolveRepoPath(canonicalItem.repository) ?? process.cwd() : process.cwd();
    let planText = await runCli(command, ["--print", "--output-format", "text", buildPrompt(canonicalItem)], cwd);
    let quality = validateImplementationPlan(planText);
    if (!quality.valid) {
      planText = await runCli(command, ["--print", "--output-format", "text", buildImprovePrompt(planText, quality.missing)], cwd);
      quality = validateImplementationPlan(planText);
    }

    ctx.db.setWorkItemPlan(canonicalItem.id, planText, quality);

    const link = ctx.db.raw.prepare(
      `SELECT * FROM github_links WHERE work_item_id = ? AND issue_number IS NOT NULL ORDER BY id ASC LIMIT 1`,
    ).get(canonicalItem.id) as { repository: string; issue_number: number } | undefined;
    if (link) {
      const comment = buildGithubWorkItemComment(ctx.db, ctx.db.getWorkItem(canonicalItem.id) ?? canonicalItem);
      await runCommand("gh", ["issue", "comment", String(link.issue_number), "--repo", link.repository, "--body", comment]);
    }

    if (input.approve_after_plan === true) {
      enqueuePostPlanImplementation(ctx, canonicalItem.id, canonicalItem.repository, input);
    }

    return {
      summary: `Implementation plan ready for work item #${canonicalItem.id}. Review the approval pack before approving.`,
      work_item_id: canonicalItem.id,
      work_item_ids: [canonicalItem.id],
      plan_quality: quality,
    };
  };
}
