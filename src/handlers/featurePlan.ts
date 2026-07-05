/**
 * PURPOSE: Job handler for feature_plan task type.
 * Builds a repo inspection + TDD-structured planning prompt, runs it via CLI,
 * stores the result in the feature_plans scope_json, creates a proposed work_item,
 * and transitions the plan to 'ready'.
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts, src/handlers/defectScan.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";
import { createWorkerPromptFileReader } from "../workerPromptFileReader.js";
import { loadWorkerPrompt } from "../workerPrompts.js";

type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;

interface FeaturePlanDeps {
  runCli: RunCli;
  command?: string;
}

const promptReader = createWorkerPromptFileReader();

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

    const repository = typeof input.repository === "string" ? input.repository : undefined;
    const prompt = await loadWorkerPrompt(
      "feature_plan",
      {
        brief: plan.brief,
        repository: repository ?? "(unknown)",
      },
      promptReader,
      { dbTemplate: ctx.db.getPrompt("feature_plan", "") },
    );
    const planText = await runCli(command, ["--print", "--output-format", "text", prompt]);

    // Persist the generated plan into scope_json
    ctx.db.updateFeaturePlanScope(planId, { plan_text: planText });
    ctx.db.updateFeaturePlanStatus(planId, "ready");

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
