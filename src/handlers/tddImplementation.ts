/**
 * PURPOSE: Job handler for tdd_implementation task type.
 * Creates an isolated agent branch, runs two CLI passes (red tests then green
 * implementation), commits each separately, runs the verification suite, and
 * transitions the work_item to in_progress.
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";
import { buildExecutionPromptContext, extractExecutionContract } from "../workerPromptContracts.js";
import type { WorkerExecutionContract } from "../workerPromptContracts.js";
import { createWorkerPromptFileReader } from "../workerPromptFileReader.js";
import { getExecutionContractFromMetadata } from "../workerPromptPlanMetadata.js";
import { loadWorkerPrompt, truncateWorkerPromptValue } from "../workerPrompts.js";
import type { WorkerPromptKey } from "../workerPrompts.js";

type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;
type RunGit = (args: string[], cwd: string) => string | Promise<string>;
type RunTests = (cwd: string) => { ok: boolean; output: string } | Promise<{ ok: boolean; output: string }>;
const TEST_ONLY_SOURCE_PATTERN = "from ['\"]vitest|import\\(['\"]vitest|VITEST_WORKER_ID|delete process\\.env\\.WORKER_DEFAULT_REPO";

interface TddImplementationDeps {
  runCli: RunCli;
  runGit: RunGit;
  runTests: RunTests;
  command?: string;
  /** Extra CLI flags inserted before the prompt (e.g. permission mode). */
  cliExtraArgs?: string[];
  /** Clone the repository into a disposable per-job directory. */
  prepareWorkspace?: (repository: string, workItemId: number, opts?: { reuseExisting?: boolean }) => Promise<string>;
  /** Remove a workspace directory (no-op outside the workspace base). */
  cleanupWorkspace?: (dir: string) => void;
}

const promptReader = createWorkerPromptFileReader();

function notifyFields(input: JobHandlerInput): Record<string, number> {
  return {
    ...(typeof input.notify_chat_id === "number" ? { notify_chat_id: input.notify_chat_id } : {}),
    ...(typeof input.notify_thread_id === "number" ? { notify_thread_id: input.notify_thread_id } : {}),
  };
}

/** True for paths that belong to test code. */
export function isTestPath(path: string): boolean {
  return (
    /(^|\/)tests?\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)test_[^/]+\.py$/.test(path) ||
    /_test\.py$/.test(path)
  );
}

function buildFallbackExecutionContract(title: string): WorkerExecutionContract {
  return {
    target_files: [],
    test_files: [],
    phase_order: ["red-test", "green-implementation", "verification"],
    red_test_command: "npm test",
    verification_command: "npm test",
    risk_level: "medium",
    human_decision_required: false,
    out_of_scope: ["unrelated cleanup", "unapproved scope expansion"],
    notes_for_red_pass: `Add required regression coverage for: ${title}`,
    notes_for_green_pass: `Implement the smallest production change for: ${title}`,
  };
}

function getPlanContext(
  ctx: JobHandlerContext,
  item: { id: number; title: string; body: string | null },
  phase: "red" | "green" | "ci_fix" | "repair",
  failureOutput = "",
) {
  const plan = ctx.db.getWorkItemPlan(item.id);
  const planText = plan?.plan_text?.trim() || item.body?.trim() || item.title;

  let executionContract = plan ? getExecutionContractFromMetadata(plan.quality_json) : null;
  if (!executionContract && planText) {
    const extracted = extractExecutionContract(planText);
    if (extracted.ok) executionContract = extracted.contract;
  }
  executionContract ??= buildFallbackExecutionContract(item.title);

  const context = buildExecutionPromptContext({
    planText,
    executionContract,
    phase,
    failureOutput,
  });

  return {
    ...context,
    plan_text: truncateWorkerPromptValue([context.plan_text, planText].filter(Boolean).join("\n\n"), 2_400),
  };
}

async function loadTddPrompt(
  ctx: JobHandlerContext,
  key: WorkerPromptKey,
  variables: Record<string, unknown>,
): Promise<string> {
  return loadWorkerPrompt(key, variables, promptReader, {
    dbTemplate: ctx.db.getPrompt(key, ""),
  });
}

async function assertNoTestOnlyCodeInProduction(runGit: RunGit, repoPath: string): Promise<void> {
  try {
    const matches = await runGit(["grep", "-nE", TEST_ONLY_SOURCE_PATTERN, "--", "src"], repoPath);
    if (matches.trim()) {
      throw new Error(`test-only code leaked into production source:\n${matches.trim()}`);
    }
  } catch (err) {
    if (err instanceof Error && /test-only code leaked/.test(err.message)) throw err;
    // git grep exits non-zero when there are no matches; that is the desired state.
  }
}

export function createTddImplementationHandler(deps: TddImplementationDeps): JobHandler {
  const { runCli, runGit, runTests, command = "claude", cliExtraArgs = [], prepareWorkspace } = deps;

  return async function tddImplementationHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const workItemId = typeof input.work_item_id === "number" ? input.work_item_id : null;
    if (workItemId === null) throw new Error("input.work_item_id is required");

    const item = ctx.db.getWorkItem(workItemId);
    if (!item) throw new Error(`Work item ${workItemId} not found`);

    let repoPath: string;
    let workspaceDir: string | null = null;
    if (typeof input.repository_path === "string") {
      repoPath = input.repository_path;
    } else if (item.repository && prepareWorkspace) {
      workspaceDir = await prepareWorkspace(item.repository, workItemId, {
        reuseExisting: Boolean(input.repair_of_job_id || input.repair_context),
      });
      repoPath = workspaceDir;
    } else {
      throw new Error(
        `Work item ${workItemId} has no repository_path and no resolvable repository — refusing to run in the worker's own directory`,
      );
    }

    const readStaged = async (): Promise<string[]> =>
      (await runGit(["diff", "--cached", "--name-only"], repoPath))
        .split("\n").map(l => l.trim()).filter(Boolean);

    try {
      const status = await runGit(["status", "--porcelain"], repoPath);
      if (status.trim()) {
        throw new Error(`Repository has uncommitted changes (dirty working tree):\n${status}`);
      }

      const branchName = `agent/work-${workItemId}`;
      if (input.ci_fix) {
        await Promise.resolve(runGit(["fetch", "origin", branchName], repoPath)).catch(() => {});
        await Promise.resolve(runGit(["checkout", branchName], repoPath)).catch(async () => {
          await Promise.resolve(runGit(["checkout", "-b", branchName, `origin/${branchName}`], repoPath));
        });
        const ciSummary = typeof input.ci_failure_summary === "string" ? input.ci_failure_summary : "";
        const ciLog = typeof input.ci_failure_log === "string" ? input.ci_failure_log : "";
        const promptContext = getPlanContext(ctx, item, "ci_fix", `${ciSummary}\n${ciLog}`);
        const ciPrompt = await loadTddPrompt(ctx, "tdd_implementation:ci_fix", {
          title: item.title,
          execution_contract: promptContext.execution_contract,
          plan_text: promptContext.plan_text,
          failure_output: promptContext.failure_output,
        });
        await runCli(command, ["--print", "--output-format", "text", ...cliExtraArgs, ciPrompt], repoPath);

        await runGit(["add", "-A"], repoPath);
        const staged = await readStaged();
        if (staged.length === 0) {
          throw new Error("CI fix staged no files");
        }

        const verifyRun = await runTests(repoPath);
        if (!verifyRun.ok) {
          throw new Error(`Verification failed after CI fix:\n${verifyRun.output}`);
        }
        await assertNoTestOnlyCodeInProduction(runGit, repoPath);

        await runGit(["commit", "-m", `fix: repair CI for ${item.title}`], repoPath);
        await runGit(["push", "origin", branchName], repoPath);
        const headSha = (await runGit(["rev-parse", "HEAD"], repoPath)).trim();

        ctx.db.updateWorkItemStatus(workItemId, "in_progress");
        const repository = typeof input.repository === "string" ? input.repository : item.repository;
        if (repository) {
          const link = ctx.db.raw
            .prepare("SELECT id FROM github_links WHERE repository = ? AND branch_name = ?")
            .get(repository, branchName) as { id: number } | undefined;
          if (link) ctx.db.updatePrState(link.id, "draft");
        }
        ctx.db.createWorkJob({
          task_type: "pr_watch",
          idempotency_key: `pr_watch:ci_fix:${workItemId}:${headSha}`,
          max_attempts: 1,
        });

        const summary = `CI fix pushed on **${branchName}** (${headSha.slice(0, 7)}); PR watch queued.`;
        return { summary, branchName, verifyOutput: verifyRun.output, headSha };
      } else if (input.repair_of_job_id || input.repair_context) {
        await Promise.resolve(runGit(["checkout", branchName], repoPath)).catch(async () => {
          await Promise.resolve(runGit(["checkout", "-b", branchName], repoPath));
        });
        const priorError = typeof input.repair_context === "string" ? input.repair_context : "";
        const promptContext = getPlanContext(ctx, item, "repair", priorError);
        const repairPrompt = await loadTddPrompt(ctx, "tdd_implementation:repair", {
          title: item.title,
          execution_contract: promptContext.execution_contract,
          plan_text: promptContext.plan_text,
          failure_output: promptContext.failure_output,
        });
        await runCli(command, ["--print", "--output-format", "text", ...cliExtraArgs, repairPrompt], repoPath);

        await runGit(["add", "-A"], repoPath);
        const staged = await readStaged();
        if (staged.length === 0) {
          throw new Error("Repair pass staged no files");
        }

        const verifyRun = await runTests(repoPath);
        if (!verifyRun.ok) {
          throw new Error(`Verification failed after repair:\n${verifyRun.output}`);
        }
        await assertNoTestOnlyCodeInProduction(runGit, repoPath);

        await runGit(["commit", "-m", `fix: repair ${item.title}`], repoPath);
        ctx.db.updateWorkItemStatus(workItemId, "in_progress");
        if (item.repository) {
          ctx.db.createWorkJob({
            task_type: "pr_lifecycle",
            idempotency_key: `pr_lifecycle:${workItemId}:repair:${Date.now()}`,
            work_item_id: workItemId,
            input_json: {
              work_item_id: workItemId,
              branch_name: branchName,
              repository: item.repository,
              repository_path: repoPath,
              ...(workspaceDir ? { workspace_dir: workspaceDir } : {}),
              verify_output: verifyRun.output,
              ...notifyFields(input),
            },
          });
        }

        const summary = `Repair complete on **${branchName}**`;
        return { summary, branchName, verifyOutput: verifyRun.output };
      } else {
        await runGit(["checkout", "-b", branchName], repoPath);
      }

      const redContext = getPlanContext(ctx, item, "red");
      const redPrompt = await loadTddPrompt(ctx, "tdd_implementation:red_test", {
        work_item_id: workItemId,
        title: item.title,
        execution_contract: redContext.execution_contract,
        plan_text: redContext.plan_text,
      });
      await runCli(command, ["--print", "--output-format", "text", ...cliExtraArgs, redPrompt], repoPath);

      await runGit(["add", "-A"], repoPath);
      const redStaged = await readStaged();
      const prodInRed = redStaged.filter(p => !isTestPath(p));
      if (prodInRed.length > 0) {
        throw new Error(`Red pass staged production files — test commit must contain tests only: ${prodInRed.join(", ")}`);
      }
      if (redStaged.length === 0) {
        throw new Error("Red pass staged no test files");
      }

      const redRun = await runTests(repoPath);
      if (redRun.ok) {
        throw new Error("Red tests did not fail — refusing to commit tests that pass without the fix");
      }

      await runGit(
        ["commit", "-m", `test: failing coverage for ${item.title}`],
        repoPath,
      );

      const greenContext = getPlanContext(ctx, item, "green");
      const greenPrompt = await loadTddPrompt(ctx, "tdd_implementation:green_implementation", {
        work_item_id: workItemId,
        title: item.title,
        execution_contract: greenContext.execution_contract,
        plan_text: greenContext.plan_text,
      });
      await runCli(command, ["--print", "--output-format", "text", ...cliExtraArgs, greenPrompt], repoPath);

      await runGit(["add", "-A"], repoPath);
      const greenStaged = await readStaged();
      const testsInGreen = greenStaged.filter(isTestPath);
      if (testsInGreen.length > 0) {
        throw new Error(`Green pass modified test files — implementation commit must not touch tests: ${testsInGreen.join(", ")}`);
      }

      const greenRun = await runTests(repoPath);
      if (!greenRun.ok) {
        throw new Error(`Verification failed after implementation:\n${greenRun.output}`);
      }
      await assertNoTestOnlyCodeInProduction(runGit, repoPath);

      await runGit(
        ["commit", "-m", `fix: ${item.title}`],
        repoPath,
      );

      ctx.db.updateWorkItemStatus(workItemId, "in_progress");

      if (item.repository) {
        ctx.db.createWorkJob({
          task_type: "pr_lifecycle",
          idempotency_key: `pr_lifecycle:${workItemId}`,
          work_item_id: workItemId,
          input_json: {
            work_item_id: workItemId,
            branch_name: branchName,
            repository: item.repository,
            repository_path: repoPath,
            ...(workspaceDir ? { workspace_dir: workspaceDir } : {}),
            ...notifyFields(input),
          },
        });
      }

      const summary = `TDD implementation complete on **${branchName}**`;
      return { summary, branchName, verifyOutput: greenRun.output };
    } catch (err) {
      throw err;
    }
  };
}
