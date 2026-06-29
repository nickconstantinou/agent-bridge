/**
 * PURPOSE: Job handler for tdd_implementation task type.
 * Creates an isolated agent branch, runs two CLI passes (red tests then green
 * implementation), commits each separately, runs the verification suite, and
 * transitions the work_item to in_progress.
 * NEIGHBORS: src/jobExecutor.ts, src/db.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";

type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;
type RunGit = (args: string[], cwd: string) => string | Promise<string>;
type RunTests = (cwd: string) => { ok: boolean; output: string } | Promise<{ ok: boolean; output: string }>;
const TEST_ONLY_SOURCE_PATTERN = "from ['\\\"]vitest|import\\(['\\\"]vitest|VITEST_WORKER_ID|delete process\\.env\\.WORKER_DEFAULT_REPO";

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

/** True for paths that belong to test code. */
export function isTestPath(path: string): boolean {
  return (
    /(^|\/)tests?\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)test_[^/]+\.py$/.test(path) ||
    /_test\.py$/.test(path)
  );
}

function buildRedTestPrompt(title: string, body: string | null): string {
  return `You are implementing a fix using strict TDD. The work item is:

Title: ${title}
${body ? `Details: ${body}\n` : ""}
**Step 1 of 2 — Write failing tests only.**

Your task:
1. Understand the issue from the title and details.
2. Write focused failing tests that describe the desired behaviour.
3. Run the tests and confirm they fail (red state).
4. Do NOT implement the fix yet — only the tests.
5. Stage all new/modified test files with: git add <test files>

Do not modify production code. Do not commit — just stage the test files.`;
}

function buildGreenImplementationPrompt(title: string, body: string | null): string {
  return `You are implementing a fix using strict TDD. The work item is:

Title: ${title}
${body ? `Details: ${body}\n` : ""}
**Step 2 of 2 — Implement the smallest change to make the tests pass.**

The failing tests have already been committed. Your task:
1. Read the committed test files to understand what must pass.
2. Implement the minimal production code change to make those tests green.
3. Run the full test suite and confirm it passes.
4. Confirm the implementation satisfies the architectural intent in the work item, not just the test assertions.
5. For architecture/refactor work, ensure the production path uses the new boundary/abstraction and include a before/after ownership check in your reasoning.
6. Stage all modified production files with: git add <files>

Architectural acceptance criteria:
- The production path must use the intended abstraction/boundary, not merely add unused classes or helpers.
- Test-only imports, test environment cleanup, or Vitest hooks must not be added to production source under src/.
- If the request is a refactor, verify the before/after ownership changed in the production code.

Do not modify test files. Do not commit — just stage the production files.`;
}

function buildCiFixPrompt(title: string, body: string | null, ciSummary: string, ciLog: string): string {
  return `You are repairing a failing CI check on an existing agent PR branch.

Title: ${title}
${body ? `Details: ${body}\n` : ""}
CI failure summary:
${ciSummary || "(no summary provided)"}

Failed CI log excerpt:
${ciLog || "(no log provided)"}

Your task:
1. Diagnose the failing CI check from the log.
2. Make the smallest code or test update required to make CI pass.
3. Preserve architectural intent: production code must use intended abstractions, and test-only hooks/imports must stay out of src/.
4. Run the relevant tests locally, then the full verification command if practical.
5. Stage all modified files with: git add <files>

Do not open or merge a PR. Do not commit — just stage the fix.`;
}

function buildRepairPrompt(title: string, body: string | null, priorError: string): string {
  return `You are repairing a failed autonomous TDD implementation attempt.

Title: ${title}
${body ? `Details: ${body}\n` : ""}
Previous failure:
${priorError || "(no failure context provided)"}

Your task:
1. Diagnose the prior failure before changing files.
2. Reuse the existing worktree state if present.
3. Make the smallest correction needed so verification passes.
4. Preserve architectural intent: production paths must use intended abstractions, not just satisfy narrow tests.
5. Keep test-only imports/env cleanup out of src/.
6. Run the relevant focused test first, then the full suite if practical.
7. Stage all modified files with: git add <files>

Do not open or merge a PR. Do not commit — just stage the repair.`;
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

    // Resolve the working directory: explicit path, or a disposable workspace
    // cloned from the local checkout. Never default to the worker's own cwd.
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
      // Pre-flight: repo must be clean
      const status = await runGit(["status", "--porcelain"], repoPath);
      if (status.trim()) {
        throw new Error(`Repository has uncommitted changes (dirty working tree):\n${status}`);
      }

      // Create isolated agent branch
      const branchName = `agent/work-${workItemId}`;
      if (input.ci_fix) {
        await Promise.resolve(runGit(["fetch", "origin", branchName], repoPath)).catch(() => {});
        await Promise.resolve(runGit(["checkout", branchName], repoPath)).catch(async () => {
          await Promise.resolve(runGit(["checkout", "-b", branchName, `origin/${branchName}`], repoPath));
        });
        const ciSummary = typeof input.ci_failure_summary === "string" ? input.ci_failure_summary : "";
        const ciLog = typeof input.ci_failure_log === "string" ? input.ci_failure_log : "";
        const ciPrompt = buildCiFixPrompt(item.title, item.body, ciSummary, ciLog);
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
        const branchName = `agent/work-${workItemId}`;
        await Promise.resolve(runGit(["checkout", branchName], repoPath)).catch(async () => {
          await Promise.resolve(runGit(["checkout", "-b", branchName], repoPath));
        });
        const priorError = typeof input.repair_context === "string" ? input.repair_context : "";
        const repairPrompt = buildRepairPrompt(item.title, item.body, priorError);
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
              ...(typeof input.notify_chat_id === "number" ? { notify_chat_id: input.notify_chat_id } : {}),
            },
          });
        }

        const summary = `Repair complete on **${branchName}**`;
        return { summary, branchName, verifyOutput: verifyRun.output };
      } else {
        await runGit(["checkout", "-b", branchName], repoPath);
      }

      // ── Red: write failing tests ────────────────────────────────────────────
      const redPrompt = buildRedTestPrompt(item.title, item.body);
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

      // ── Green: implement the fix ────────────────────────────────────────────
      const greenPrompt = buildGreenImplementationPrompt(item.title, item.body);
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

      // Queue PR lifecycle job if item is linked to a repository
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
            ...(typeof input.notify_chat_id === "number" ? { notify_chat_id: input.notify_chat_id } : {}),
          },
        });
      }

      const summary = `TDD implementation complete on **${branchName}**`;
      return { summary, branchName, verifyOutput: greenRun.output };
    } catch (err) {
      // Preserve failed workspaces for repair jobs; cleanup happens after PR merge/close.
      throw err;
    }
  };
}
