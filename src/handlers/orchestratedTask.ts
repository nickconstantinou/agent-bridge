/**
 * PURPOSE: Resumable multi-phase implementation job handler.
 * Plans, executes, verifies, then queues PR lifecycle work behind the existing
 * human merge gate.
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts, src/handlers/prLifecycle.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";
import { isCodeCliAllowed } from "../workerCliPolicy.js";

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
}

interface OrchestratedPhaseData {
  workItemId?: number;
  repoPath?: string;
  workspaceDir?: string | null;
  branchName?: string;
  plan?: string;
  preferredCli?: CliKind;
  verifyOutput?: string;
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

function buildPlanPrompt(title: string, body: string | null): string {
  return `Plan this implementation job before editing.

Title: ${title}
${body ? `Details: ${body}\n` : ""}
Return a concise numbered plan with verification steps. Do not edit files.`;
}

function buildExecutePrompt(title: string, body: string | null, plan: string): string {
  return `Execute this implementation plan.

Title: ${title}
${body ? `Details: ${body}\n` : ""}
Plan:
${plan}

Make the smallest coherent code changes needed. Stage changed files with git add -A. Do not commit.`;
}

export function createOrchestratedTaskHandler(deps: OrchestratedTaskDeps): JobHandler {
  const { runCli, runGit, runTests, cliExtraArgs = [], prepareWorkspace, cleanupWorkspace } = deps;

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

      const plan = await runCli(command, ["--print", "--output-format", "text", ...cliExtraArgs, buildPlanPrompt(item.title, item.body)], repoPath);
      return {
        status: "continue",
        phase: "executing",
        phaseData: { workItemId, repoPath, workspaceDir, branchName, plan, preferredCli: selectedCli ?? undefined },
        summary: `Plan complete for work item #${workItemId}; executing next.`,
      };
    }

    if (ctx.phase === "executing") {
      if (!phaseData.repoPath || !phaseData.plan) throw new Error("orchestrated_task missing execution phase data");
      await runCli(command, ["--print", "--output-format", "text", ...cliExtraArgs, buildExecutePrompt(item.title, item.body, phaseData.plan)], phaseData.repoPath);
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
            ...(typeof input.notify_chat_id === "number" ? { notify_chat_id: input.notify_chat_id } : {}),
          },
        });
      } else if (phaseData.workspaceDir && cleanupWorkspace) {
        cleanupWorkspace(phaseData.workspaceDir);
      }

      return {
        summary: `Orchestrated task complete for **${phaseData.branchName}**\n\n${verify.output}`,
        branchName: phaseData.branchName,
        verifyOutput: verify.output,
      };
    }

    throw new Error(`Unknown orchestrated_task phase: ${ctx.phase}`);
  };
}
