/**
 * PURPOSE: Resumable multi-phase implementation job handler.
 * Plans, executes, verifies, then queues PR lifecycle work behind the existing
 * human merge gate.
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts, src/handlers/prLifecycle.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";
import { isCodeCliAllowed } from "../workerCliPolicy.js";
import { createWorkerPromptFileReader } from "../workerPromptFileReader.js";
import { loadWorkerPrompt } from "../workerPrompts.js";

type CliKind = "codex" | "claude" | "antigravity";
type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;
type RunGit = (args: string[], cwd: string) => string | Promise<string>;
type RunTests = (cwd: string) => { ok: boolean; output: string } | Promise<{ ok: boolean; output: string }>;

interface OrchestratedTaskDeps {
  runCli: RunCli;
  runGit: RunGit;
  runTests: RunTests;
  command?: string;
  commands?: Partial<Record<CliKind, string>>;
  cliExtraArgs?: string[];
  prepareWorkspace?: (repository: string, workItemId: number, opts?: { reuseExisting?: boolean }) => Promise<string>;
  cleanupWorkspace?: (dir: string) => void;
  advisorCheckpoint?: (input: {
    mode: "plan" | "pr_ready";
    taskKey: string;
    task: string;
    repoPath: string;
    diffSummary?: string;
    testOutput?: string;
  }) => Promise<string>;
}

const promptReader = createWorkerPromptFileReader();

function notifyFields(input: JobHandlerInput): Record<string, number> {
  return {
    ...(typeof input.notify_chat_id === "number" ? { notify_chat_id: input.notify_chat_id } : {}),
    ...(typeof input.notify_thread_id === "number" ? { notify_thread_id: input.notify_thread_id } : {}),
  };
}

interface OrchestratedPhaseData {
  workItemId?: number;
  repoPath?: string;
  workspaceDir?: string | null;
  branchName?: string;
  plan?: string;
  preferredCli?: CliKind;
  verifyOutput?: string;
  advisorPlan?: string;
  advisorPrReady?: string;
}

function preferredCli(input: JobHandlerInput): CliKind | null {
  const value = input.preferred_cli;
  return value === "codex" || value === "claude" || value === "antigravity" ? value : null;
}

function commandFor(deps: OrchestratedTaskDeps, cli: CliKind | null): string {
  if (cli && deps.commands?.[cli]) return deps.commands[cli]!;
  if (cli === "codex") return process.env.CODEX_COMMAND || "codex";
  if (cli === "antigravity") return process.env.ANTIGRAVITY_COMMAND || "agy";
  if (cli === "claude") return process.env.CLAUDE_COMMAND || "claude";
  return deps.command || "claude";
}

async function buildPlanPrompt(ctx: JobHandlerContext, item: { repository: string | null; title: string; body: string | null }): Promise<string> {
  return loadWorkerPrompt(
    "orchestrated_task:plan",
    {
      repository: item.repository ?? "(unknown)",
      title: item.title,
      body: item.body ?? "",
    },
    promptReader,
    { dbTemplate: ctx.db.getPrompt("orchestrated_task:plan", "") },
  );
}

async function buildExecutePrompt(ctx: JobHandlerContext, title: string, plan: string, advisorPlan?: string): Promise<string> {
  return loadWorkerPrompt(
    "orchestrated_task:execute",
    {
      title,
      plan_text: plan,
      execution_contract: advisorPlan ? `Frontier advisor review:\n${advisorPlan}` : "",
    },
    promptReader,
    { dbTemplate: ctx.db.getPrompt("orchestrated_task:execute", "") },
  );
}

export function createOrchestratedTaskHandler(deps: OrchestratedTaskDeps): JobHandler {
  const { runCli, runGit, runTests, cliExtraArgs = [], prepareWorkspace, cleanupWorkspace, advisorCheckpoint } = deps;

  const consultAdvisor = async (
    input: JobHandlerInput,
    checkpoint: Parameters<NonNullable<OrchestratedTaskDeps["advisorCheckpoint"]>>[0],
  ): Promise<string | undefined> => {
    if (!advisorCheckpoint) {
      if (input.advisor_required === true) throw new Error("Advisor required but disabled or unavailable");
      return undefined;
    }
    try {
      return await advisorCheckpoint(checkpoint);
    } catch (error) {
      if (input.advisor_required === true) throw error;
      console.warn(`[advisor] optional worker checkpoint failed mode=${checkpoint.mode}:`, error);
      return undefined;
    }
  };

  return async function orchestratedTaskHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const phaseData = ctx.phaseData as OrchestratedPhaseData;
    const workItemId = typeof input.work_item_id === "number" ? input.work_item_id : phaseData.workItemId;
    if (typeof workItemId !== "number") throw new Error("input.work_item_id is required");

    const item = ctx.db.getWorkItem(workItemId);
    if (!item) throw new Error(`Work item ${workItemId} not found`);

    const selectedCli = preferredCli(input) ?? phaseData.preferredCli ?? null;
    if (selectedCli && !isCodeCliAllowed(selectedCli)) {
      throw new Error(`CLI ${selectedCli} is not allowed for orchestrated_task code-writing phases`);
    }
    const command = commandFor(deps, selectedCli);
    const branchName = phaseData.branchName ?? `agent/work-${workItemId}`;

    if (ctx.phase === "initial") {
      let repoPath: string;
      let workspaceDir: string | null = null;
      if (typeof input.repository_path === "string") {
        repoPath = input.repository_path;
      } else if (item.repository && prepareWorkspace) {
        workspaceDir = await prepareWorkspace(item.repository, workItemId);
        repoPath = workspaceDir;
      } else {
        throw new Error(
          `Work item ${workItemId} has no repository_path and no resolvable repository — refusing to run in the worker's own directory`,
        );
      }

      const status = await runGit(["status", "--porcelain"], repoPath);
      if (String(status).trim()) {
        throw new Error(`Repository has uncommitted changes (dirty working tree):\n${status}`);
      }
      await runGit(["checkout", "-b", branchName], repoPath);

      const planPrompt = await buildPlanPrompt(ctx, item);
      const plan = await runCli(command, ["--print", "--output-format", "text", ...cliExtraArgs, planPrompt], repoPath);
      const advisorPlan = await consultAdvisor(input, {
        mode: "plan",
        taskKey: `work-item:${workItemId}`,
        task: `Review the implementation plan for: ${item.title}`,
        repoPath,
        diffSummary: plan,
      });
      return {
        status: "continue",
        phase: "executing",
        // The selected, bounded recommendation is intentionally carried in
        // resumable phase state so execution can continue after a restart.
        // Advisor audit tables still never store prompts or raw advice.
        phaseData: { workItemId, repoPath, workspaceDir, branchName, plan, advisorPlan, preferredCli: selectedCli ?? undefined },
        summary: `Plan complete for work item #${workItemId}; executing next.`,
      };
    }

    if (ctx.phase === "executing") {
      if (!phaseData.repoPath || !phaseData.plan) throw new Error("orchestrated_task missing execution phase data");
      const executePrompt = await buildExecutePrompt(ctx, item.title, phaseData.plan, phaseData.advisorPlan);
      await runCli(command, ["--print", "--output-format", "text", ...cliExtraArgs, executePrompt], phaseData.repoPath);
      await runGit(["add", "-A"], phaseData.repoPath);
      const staged = String(await runGit(["diff", "--cached", "--name-only"], phaseData.repoPath)).trim();
      if (!staged) throw new Error("Execution phase staged no changes");
      await runGit(["commit", "-m", `implement: ${item.title}`], phaseData.repoPath);
      ctx.db.updateWorkItemStatus(workItemId, "in_progress");
      return {
        status: "continue",
        phase: "verifying",
        phaseData,
        summary: `Implementation committed for work item #${workItemId}; verifying next.`,
      };
    }

    if (ctx.phase === "verifying") {
      if (!phaseData.repoPath || !phaseData.branchName) throw new Error("orchestrated_task missing verification phase data");
      const verify = await runTests(phaseData.repoPath);
      if (!verify.ok) throw new Error(`Verification failed:\n${verify.output}`);
      const advisorPrReady = await consultAdvisor(input, {
        mode: "pr_ready",
        taskKey: `work-item:${workItemId}`,
        task: `Review PR readiness for: ${item.title}`,
        repoPath: phaseData.repoPath,
        testOutput: verify.output,
        diffSummary: phaseData.plan,
      });

      if (item.repository) {
        ctx.db.createWorkJob({
          task_type: "pr_lifecycle",
          idempotency_key: `pr_lifecycle:${workItemId}`,
          work_item_id: workItemId,
          input_json: {
            work_item_id: workItemId,
            branch_name: phaseData.branchName,
            repository: item.repository,
            repository_path: phaseData.repoPath,
            verify_output: verify.output,
            ...(phaseData.workspaceDir ? { workspace_dir: phaseData.workspaceDir } : {}),
            ...notifyFields(input),
          },
        });
      } else if (phaseData.workspaceDir && cleanupWorkspace) {
        cleanupWorkspace(phaseData.workspaceDir);
      }

      return {
        summary: `Orchestrated task complete for **${phaseData.branchName}**\n\n${verify.output}${advisorPrReady ? `\n\nAdvisor: ${advisorPrReady}` : ""}`,
        branchName: phaseData.branchName,
        verifyOutput: verify.output,
        advisorPrReady,
      };
    }

    throw new Error(`Unknown orchestrated_task phase: ${ctx.phase}`);
  };
}
