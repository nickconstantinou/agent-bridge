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
import { extractExecutionContract } from "../workerPromptContracts.js";
import { createWorkerPromptFileReader } from "../workerPromptFileReader.js";
import { withExecutionContractMetadata } from "../workerPromptPlanMetadata.js";
import { loadWorkerPrompt } from "../workerPrompts.js";

type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;
type RunCommand = (binary: string, args: string[]) => Promise<string>;

interface ImplementationPlanDeps {
  runCli: RunCli;
  command?: string;
  runCommand?: RunCommand;
  resolveRepoPath?: (repository: string) => string | null;
}

export { validateImplementationPlan };

const promptReader = createWorkerPromptFileReader();
const GH_ISSUE = "issue";
const GH_VIEW = "view";
const GH_COMMENT = "comment";

async function buildCreatePrompt(ctx: JobHandlerContext, input: WorkItem): Promise<string> {
  return loadWorkerPrompt(
    "implementation_plan:create",
    {
      repository: input.repository ?? "(unknown)",
      kind: input.kind,
      source: input.source,
      title: input.title,
      body: input.body ?? "(none)",
    },
    promptReader,
    { dbTemplate: ctx.db.getPrompt("implementation_plan:create", "") },
  );
}

async function buildImprovePrompt(ctx: JobHandlerContext, planText: string, missing: string[]): Promise<string> {
  return loadWorkerPrompt(
    "implementation_plan:improve",
    {
      missing: missing.map(m => `- ${m}`).join("\n"),
      planText,
      plan_text: planText,
    },
    promptReader,
    { dbTemplate: ctx.db.getPrompt("implementation_plan:improve", "") },
  );
}

async function buildContractRepairPrompt(ctx: JobHandlerContext, planText: string): Promise<string> {
  return loadWorkerPrompt(
    "implementation_plan:contract_repair",
    { planText, plan_text: planText },
    promptReader,
    { dbTemplate: ctx.db.getPrompt("implementation_plan:contract_repair", "") },
  );
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
    GH_ISSUE, GH_VIEW, String(link.issue_number),
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
    let planText = await runCli(command, ["--print", "--output-format", "text", await buildCreatePrompt(ctx, canonicalItem)], cwd);
    let quality = validateImplementationPlan(planText);
    let contractResult = extractExecutionContract(planText);

    if (!quality.valid || !contractResult.ok) {
      const missing = [
        ...quality.missing,
        ...(contractResult.ok ? [] : [`missing or invalid execution contract: ${contractResult.error}`]),
      ];
      planText = await runCli(command, ["--print", "--output-format", "text", await buildImprovePrompt(ctx, planText, missing)], cwd);
      quality = validateImplementationPlan(planText);
      contractResult = extractExecutionContract(planText);
    }

    if (
      quality.valid &&
      !contractResult.ok &&
      contractResult.error === "Implementation plan is missing an Execution Contract section"
    ) {
      const contractSection = await runCli(
        command,
        ["--print", "--output-format", "text", await buildContractRepairPrompt(ctx, planText)],
        cwd,
      );
      const repairedPlanText = `${planText.trim()}\n\n${contractSection.trim()}`;
      const repairedContractResult = extractExecutionContract(repairedPlanText);
      if (repairedContractResult.ok) {
        planText = repairedPlanText;
        contractResult = repairedContractResult;
      }
    }

    if (!quality.valid || !contractResult.ok) {
      const reason = contractResult.ok
        ? quality.missing.join(", ")
        : `missing or invalid execution contract: ${contractResult.error}`;
      throw new PermanentJobFailureError(`Implementation plan is not execution-ready: ${reason}`);
    }

    // Store execution_contract inside quality_json via the metadata helper.
    const qualityWithExecutionContract = withExecutionContractMetadata(quality, contractResult.contract);
    ctx.db.setWorkItemPlan(canonicalItem.id, planText, qualityWithExecutionContract);

    const link = ctx.db.raw.prepare(
      `SELECT * FROM github_links WHERE work_item_id = ? AND issue_number IS NOT NULL ORDER BY id ASC LIMIT 1`,
    ).get(canonicalItem.id) as { repository: string; issue_number: number } | undefined;
    if (link) {
      const comment = buildGithubWorkItemComment(ctx.db, ctx.db.getWorkItem(canonicalItem.id) ?? canonicalItem);
      await runCommand("gh", [GH_ISSUE, GH_COMMENT, String(link.issue_number), "--repo", link.repository, "--body", comment]);
    }

    if (input.approve_after_plan === true) {
      enqueuePostPlanImplementation(ctx, canonicalItem.id, canonicalItem.repository, input);
    }

    return {
      summary: `Implementation plan ready for work item #${canonicalItem.id}. Review the approval pack before approving.`,
      work_item_id: canonicalItem.id,
      work_item_ids: [canonicalItem.id],
      plan_quality: qualityWithExecutionContract,
    };
  };
}
