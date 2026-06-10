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
type RunVerify = (cwd: string) => string | Promise<string>;

interface TddImplementationDeps {
  runCli: RunCli;
  runGit: RunGit;
  runVerify: RunVerify;
  command?: string;
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
4. Stage all modified production files with: git add <files>

Do not modify test files. Do not commit — just stage the production files.`;
}

export function createTddImplementationHandler(deps: TddImplementationDeps): JobHandler {
  const { runCli, runGit, runVerify, command = "claude" } = deps;

  return async function tddImplementationHandler(
    input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const workItemId = typeof input.work_item_id === "number" ? input.work_item_id : null;
    const repoPath = typeof input.repository_path === "string" ? input.repository_path : process.cwd();

    if (workItemId === null) throw new Error("input.work_item_id is required");

    const item = ctx.db.getWorkItem(workItemId);
    if (!item) throw new Error(`Work item ${workItemId} not found`);

    // Pre-flight: repo must be clean
    const status = await runGit(["status", "--porcelain"], repoPath);
    if (status.trim()) {
      throw new Error(`Repository has uncommitted changes (dirty working tree):\n${status}`);
    }

    // Create isolated agent branch
    const branchName = `agent/work-${workItemId}`;
    await runGit(["checkout", "-b", branchName], repoPath);

    // ── Red: write failing tests ──────────────────────────────────────────────
    const redPrompt = buildRedTestPrompt(item.title, item.body);
    await runCli(command, ["--print", "--output-format", "text", redPrompt], repoPath);

    await runGit(["add", "-A"], repoPath);
    await runGit(
      ["commit", "-m", `test: failing coverage for ${item.title}`],
      repoPath,
    );

    // ── Green: implement the fix ──────────────────────────────────────────────
    const greenPrompt = buildGreenImplementationPrompt(item.title, item.body);
    await runCli(command, ["--print", "--output-format", "text", greenPrompt], repoPath);

    await runGit(["add", "-A"], repoPath);
    await runGit(
      ["commit", "-m", `fix: ${item.title}`],
      repoPath,
    );

    // ── Verify ────────────────────────────────────────────────────────────────
    const verifyOutput = await runVerify(repoPath);

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
          ...(typeof input.notify_chat_id === "number" ? { notify_chat_id: input.notify_chat_id } : {}),
        },
      });
    }

    const summary = `TDD implementation complete on **${branchName}**\n\n${verifyOutput}`;
    return { summary, branchName, verifyOutput };
  };
}
