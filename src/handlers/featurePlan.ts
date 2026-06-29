/**
 * PURPOSE: Job handler for feature_plan task type.
 * Builds a repo inspection + TDD-structured planning prompt, runs it via CLI,
 * stores the result in the feature_plans scope_json, creates a proposed work_item,
 * and transitions the plan to 'ready'.
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts, src/handlers/defectScan.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";

type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;

interface FeaturePlanDeps {
  runCli: RunCli;
  command?: string;
}

function buildPrompt(brief: string): string {
  return `You are an expert software architect. The user wants to implement the following feature:

"${brief}"

Your task is to produce a structured, implementation-ready plan following strict TDD principles.

Steps:
1. Examine the repository structure (file tree, package.json scripts, TypeScript interfaces, test layout).
2. Identify which files are likely to need creating or modifying.
3. Produce the plan in the following sections:

## Target Footprint
- Files to create (with purpose)
- Files likely to modify (with why)
- Ownership boundaries that must not be touched

## Red Test Specification
- Exact test file path
- Test framework command to run it
- The assertion that must FAIL before implementation starts
- Expected failure reason

## State and Schema Alterations
- Database or SQLite schema changes
- Interface/type boundary changes
- Config/env changes
- Rollback notes

## Implementation Phases
Each phase must include:
- Behaviour change description
- Red test (write first, commit separately)
- Green change (smallest implementation)
- Verification command
- Commit message

Keep phases small and independently releasable.

## Acceptance Criteria
List 3–7 verifiable criteria for the feature to be considered complete.

Important constraints:
- Do NOT write any code yet — produce the plan only.
- Every phase must have its own test-before-implementation step.
- Never mix test and implementation commits.`;
}

export function createFeaturePlanHandler(deps: FeaturePlanDeps): JobHandler {
  const { runCli, command = "claude" } = deps;

  return async function featurePlanHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const planId = typeof input.plan_id === "number" ? input.plan_id : null;
    if (planId === null) throw new Error("input.plan_id is required");

    const plan = ctx.db.getFeaturePlan(planId);
    if (!plan) throw new Error(`Feature plan ${planId} not found`);

    const prompt = buildPrompt(plan.brief);
    const planText = await runCli(command, ["--print", "--output-format", "text", prompt]);

    // Persist the generated plan into scope_json
    ctx.db.updateFeaturePlanScope(planId, { plan_text: planText });
    ctx.db.updateFeaturePlanStatus(planId, "ready");

    const repository = typeof input.repository === "string" ? input.repository : undefined;

    // Create a proposed work_item so the user can approve/close via /issues
    const item = ctx.db.createWorkItem({
      kind: "feature",
      source: "telegram",
      title: `Feature: ${plan.brief}`,
      body: planText.slice(0, 4000),
      created_by: plan.user_id,
      repository,
    });
    ctx.db.setWorkItemPlan(item.id, planText, { source: "feature_plan" });

    const summary = `Feature plan ready: **${plan.brief}**\n\nUse /issues to review and approve.`;
    return { summary, planText, work_item_id: item.id, work_item_ids: [item.id] };
  };
}
