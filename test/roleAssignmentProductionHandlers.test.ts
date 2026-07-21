import { describe, expect, it, vi } from "vitest";
import { loadBotsConfig, loadRoleAssignmentConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createDefectScanHandler } from "../src/handlers/defectScan.js";
import { createFeaturePlanHandler } from "../src/handlers/featurePlan.js";
import { createGithubIssueHandler } from "../src/handlers/githubIssue.js";
import { createImplementationPlanHandler } from "../src/handlers/implementationPlan.js";
import { createOrchestratedTaskHandler } from "../src/handlers/orchestratedTask.js";
import { createPrLifecycleHandler } from "../src/handlers/prLifecycle.js";
import { createTddImplementationHandler } from "../src/handlers/tddImplementation.js";
import { validateGeneratedImplementationPlan } from "../src/implementationPlanQuality.js";
import { executeNextJob, type JobHandler } from "../src/jobExecutor.js";
import { extractExecutionContract } from "../src/workerPromptContracts.js";
import { withExecutionContractMetadata } from "../src/workerPromptPlanMetadata.js";
import { resolveWorkerCliPolicy } from "../src/workerCliPolicy.js";
import { runCliWithFallback } from "../src/workerDispatch.js";

const controlledCli = vi.hoisted(() => vi.fn());
vi.mock("../src/cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli.js")>()),
  runCli: controlledCli,
}));

const env = {
  WORKER_CLI_CHAIN: "antigravity,codex,claude",
  WORKER_CODE_CLI_CHAIN: "codex,claude",
  WORKER_SCRIBE_CLI_CHAIN: "antigravity,claude,codex",
  CODEX_COMMAND: "codex-controlled",
  CLAUDE_COMMAND: "claude-controlled",
  ANTIGRAVITY_COMMAND: "agy-controlled",
  CODEX_MODEL_PREFERENCE: "gpt-primary,gpt-fallback",
  CLAUDE_MODEL_PREFERENCE: "claude-primary,claude-fallback",
  ANTIGRAVITY_MODEL_PREFERENCE: "gemini-primary,gemini-fallback",
} as NodeJS.ProcessEnv;

const validPlan = `## Problem Summary
Preserve dormant role routing.

## Target Files
\`\`\`json
[{"path":"src/workerBot.ts","classification":"existing_at_base","owner":"worker bot","dependency_ref":null,"rationale":"production boundary"},{"path":"test/workerBot.test.ts","classification":"existing_at_base","owner":"worker tests","dependency_ref":null,"rationale":"boundary proof"}]
\`\`\`

## Architectural Intent
Keep SQLite authoritative and role routing disabled.

## Test Plan
Exercise the registered production boundary and persisted result.

## Red Tests
\`\`\`json
[{"id":"RT-1","requirement_ids":["AC-1"],"intent":{"product":["jobs retain legacy routing"],"architecture":["SQLite remains authoritative"],"invariants":["role routing remains disabled"],"risks":["compatibility"]},"test_classes":["behavioural","architecture","compatibility"],"characterization_required":true,"test_file":"test/workerBot.test.ts","test_name":"retains legacy routing","production_boundary":"registered worker handler","fixture_and_state":"dormant assignment and pending job","action_through_real_caller":"claim and execute the job","expected_observable_result":"completed persisted result","why_current_code_fails":"proof did not execute production handlers","expected_red_assertion":"expected completed production handler result","focused_red_command":"npm test -- roleAssignmentProductionHandlers","sibling_behaviour_remaining_green":["legacy routing"],"authoritative_oracle":"work_jobs result_json","false_positive_controls":["actual handler factory"]}]
\`\`\`

## Red Test Coverage
\`\`\`json
{"acceptance_coverage":[{"requirement_id":"AC-1","red_test_ids":["RT-1"],"non_test_proof":null}],"architecture_coverage":[{"boundary_or_invariant":"SQLite authority","red_test_ids":["RT-1"],"characterization_test_ids":[]}],"triggered_risk_coverage":[{"risk":"compatibility","required_test_classes":["compatibility"],"red_test_ids":["RT-1"]}]}
\`\`\`

## Implementation Phases
1. Red: add the production-boundary proof.
2. Green: retain current routing.

## Execution Contract
\`\`\`json
{"target_files":["src/workerBot.ts"],"test_files":["test/workerBot.test.ts"],"phase_order":["red-test","green-implementation","verification"],"red_test_command":"npm test -- roleAssignmentProductionHandlers","verification_command":"npm test && npm run typecheck","risk_level":"medium","human_decision_required":false,"out_of_scope":["role activation"],"notes_for_red_pass":"Prove actual handler dispatch.","notes_for_green_pass":"Preserve legacy routing."}
\`\`\`

## Acceptance Criteria
- AC-1: Jobs retain legacy routing.

## Verification Commands
npm test`;

function persistDormantAssignment(db: ReturnType<typeof openDb>): void {
  const config = loadRoleAssignmentConfig({
    WORKER_ROLE_ASSIGNMENT_SCOPE: "workspace:agent-bridge",
    WORKER_ROLE_ASSIGNMENTS_JSON: JSON.stringify([
      { role: "technical_lead", selection: "manual", primary: { cli: "claude", model: "claude-primary" }, fallbacks: [] },
      { role: "code_worker", selection: "manual", primary: { cli: "codex", model: "gpt-primary" }, fallbacks: [] },
      { role: "documentation_steward", selection: "manual", primary: { cli: "antigravity", model: "gemini-primary" }, fallbacks: [] },
    ]),
  })!;
  db.createRoleAssignmentRevision(config);
}

async function executeDurably(db: ReturnType<typeof openDb>, taskType: string, handler: JobHandler, input: Record<string, unknown>) {
  const job = db.createWorkJob({ task_type: taskType, idempotency_key: `production-handler:${taskType}`, input_json: input, max_attempts: 1 });
  const running: string[] = [];
  let execution = await executeNextJob({ db, workerId: "production-handler-worker", handlers: { [taskType]: handler }, targetJobId: job.id, notify: vi.fn(), onStart: () => { running.push(db.getWorkJob(job.id)!.status); } });
  while (db.getWorkJob(job.id)!.status === "pending") {
    execution = await executeNextJob({ db, workerId: "production-handler-worker", handlers: { [taskType]: handler }, targetJobId: job.id, notify: vi.fn(), onStart: () => { running.push(db.getWorkJob(job.id)!.status); } });
  }
  const completed = db.getWorkJob(job.id)!;
  expect(running.length).toBeGreaterThan(0);
  expect(running.every((status) => status === "running")).toBe(true);
  expect(completed.status).toBe("completed");
  expect(completed.result_json).not.toBeNull();
  expect(execution?.handlerResult).toEqual(JSON.parse(completed.result_json!));
  return execution!.handlerResult!;
}

describe("dormant assignments with production handlers", () => {
  it("claims, runs, and completes all seven actual handler factories without role routing", async () => {
    vi.stubEnv("CODEX_COMMAND", "codex-controlled");
    vi.stubEnv("CLAUDE_COMMAND", "claude-controlled");
    vi.stubEnv("ANTIGRAVITY_COMMAND", "agy-controlled");
    const db = openDb(":memory:");
    persistDormantAssignment(db);
    const policy = resolveWorkerCliPolicy(env);
    const bots = loadBotsConfig(env);
    const cliCalls: Array<{ taskType: string; command: string; cwd: string }> = [];
    const gitCalls: Array<{ taskType: string; args: string[]; cwd: string | undefined }> = [];
    const githubCalls: Array<{ taskType: string; binary: string; args: string[] }> = [];
    const diffCounts = new Map<string, number>();
    let activeTask = "";
    controlledCli.mockImplementation(async (command: string, _args: string[], cwd: string) => {
      cliCalls.push({ taskType: activeTask, command, cwd });
      const scribeTask = ["defect_scan", "feature_plan", "implementation_plan"].includes(activeTask);
      const terminalCommand = scribeTask ? "codex-controlled" : "claude-controlled";
      if (command !== terminalCommand) throw new Error("MODEL_CAPACITY_EXHAUSTED");
      if (activeTask === "defect_scan") return "No defects found.";
      if (["feature_plan", "implementation_plan", "orchestrated_task"].includes(activeTask)) return validPlan;
      return "Done.";
    });
    const routedCli = (taskType: string, chain: string[]) => async (command: string, args: string[], cwd?: string) => {
      activeTask = taskType;
      try {
        return await runCliWithFallback(command, args, cwd ?? "/tmp/repo", chain);
      } finally {
        activeTask = "";
      }
    };
    const runGit = (taskType: string) => vi.fn(async (args: string[], cwd?: string) => {
      gitCalls.push({ taskType, args, cwd });
      if (args[0] === "diff" && args.includes("--cached")) {
        const count = (diffCounts.get(taskType) ?? 0) + 1;
        diffCounts.set(taskType, count);
        return count === 1 ? "test/fix.test.ts\n" : "src/fix.ts\n";
      }
      if (args[0] === "rev-parse") return "abcdef1234567890\n";
      return "";
    });
    const runGithub = (taskType: string) => vi.fn(async (binary: string, args: string[]) => {
      githubCalls.push({ taskType, binary, args });
      if (args[0] === "issue" && args[1] === "create") return "https://github.com/owner/repo/issues/42";
      if (args[0] === "pr" && args[1] === "create") return "https://github.com/owner/repo/pull/7";
      return "";
    });
    const item = () => db.createWorkItem({ kind: "feature", source: "telegram", repository: "owner/repo", title: "Compatibility", body: "bounded", created_by: "worker" });
    try {
      const results: Record<string, Record<string, unknown>> = {};
      results.defect_scan = await executeDurably(db, "defect_scan", createDefectScanHandler({ runCli: routedCli("defect_scan", policy.scribeChain), command: bots.antigravity.command }), { repository: "owner/repo" });
      const feature = db.createFeaturePlan({ chatId: "chat", userId: "user", brief: "Compatibility" });
      results.feature_plan = await executeDurably(db, "feature_plan", createFeaturePlanHandler({ runCli: routedCli("feature_plan", policy.scribeChain), command: bots.antigravity.command }), { plan_id: feature.id, repository: "owner/repo" });
      const planned = item();
      results.implementation_plan = await executeDurably(db, "implementation_plan", createImplementationPlanHandler({ runCli: routedCli("implementation_plan", policy.scribeChain), command: bots.antigravity.command, runCommand: runGithub("implementation_plan"), resolveRepoPath: () => "/tmp/repo" }), { work_item_id: planned.id });
      const tdd = item();
      const tests = vi.fn().mockResolvedValueOnce({ ok: false, output: "red" }).mockResolvedValue({ ok: true, output: "green" });
      results.tdd_implementation = await executeDurably(db, "tdd_implementation", createTddImplementationHandler({ runCli: routedCli("tdd_implementation", policy.codeChain), command: bots.codex.command, runGit: runGit("tdd_implementation"), runTests: tests }), { work_item_id: tdd.id, repository_path: "/tmp/repo" });
      const orchestrated = item();
      results.orchestrated_task = await executeDurably(db, "orchestrated_task", createOrchestratedTaskHandler({ runCli: routedCli("orchestrated_task", policy.codeChain), command: bots.codex.command, commands: { codex: bots.codex.command, claude: bots.claude.command }, runGit: runGit("orchestrated_task"), runTests: vi.fn().mockResolvedValue({ ok: true, output: "green" }) }), { work_item_id: orchestrated.id, repository_path: "/tmp/repo" });
      const issue = item();
      results.open_github_issue = await executeDurably(db, "open_github_issue", createGithubIssueHandler({ runCommand: runGithub("open_github_issue") }), { work_item_id: issue.id, repository: "owner/repo" });
      const pr = item();
      results.pr_lifecycle = await executeDurably(db, "pr_lifecycle", createPrLifecycleHandler({ runGit: runGit("pr_lifecycle"), runCommand: runGithub("pr_lifecycle") }), { work_item_id: pr.id, branch_name: `agent/work-${pr.id}`, repository: "owner/repo", repository_path: "/tmp/repo" });

      expect(policy).toEqual({ interactiveChain: ["antigravity", "codex", "claude"], codeChain: ["codex", "claude"], scribeChain: ["antigravity", "claude", "codex"] });
      expect(bots.antigravity.modelPreference).toEqual(["gemini-primary", "gemini-fallback"]);
      expect(bots.codex.modelPreference).toEqual(["gpt-primary", "gpt-fallback"]);
      expect(bots.claude.modelPreference).toEqual(["claude-primary", "claude-fallback"]);
      const commandsFor = (taskType: string) => cliCalls.filter((call) => call.taskType === taskType).map((call) => call.command);
      expect(commandsFor("defect_scan")).toEqual(["agy-controlled", "claude-controlled", "codex-controlled"]);
      expect(commandsFor("feature_plan")).toEqual(["agy-controlled", "claude-controlled", "codex-controlled"]);
      expect(commandsFor("implementation_plan")).toEqual(["agy-controlled", "claude-controlled", "codex-controlled"]);
      expect(commandsFor("tdd_implementation")).toEqual(["codex-controlled", "claude-controlled", "codex-controlled", "claude-controlled"]);
      expect(commandsFor("orchestrated_task")).toEqual(["codex-controlled", "claude-controlled", "codex-controlled", "claude-controlled"]);
      expect(cliCalls.every((call) => call.cwd === "/tmp/repo")).toBe(true);

      const quality = validateGeneratedImplementationPlan(validPlan);
      const contract = extractExecutionContract(validPlan);
      if (!contract.ok) throw new Error(contract.error);
      expect(results.defect_scan).toEqual({ summary: "No defects found.", rawOutput: "No defects found.", findings: [], work_item_ids: [] });
      expect(results.feature_plan).toEqual({ summary: "Feature plan ready: **Compatibility**\n\nUse /issues to review and approve.", planText: validPlan, work_item_id: expect.any(Number), work_item_ids: [expect.any(Number)] });
      expect(results.implementation_plan).toEqual({ summary: `Implementation plan ready for work item #${planned.id}. Review the approval pack before approving.`, work_item_id: planned.id, work_item_ids: [planned.id], plan_quality: withExecutionContractMetadata(quality, contract.contract) });
      expect(results.tdd_implementation).toEqual({ summary: `TDD implementation complete on **agent/work-${tdd.id}**`, branchName: `agent/work-${tdd.id}`, verifyOutput: "green" });
      expect(results.orchestrated_task).toEqual({ summary: `Orchestrated task complete for **agent/work-${orchestrated.id}**\n\ngreen`, branchName: `agent/work-${orchestrated.id}`, verifyOutput: "green" });
      expect(results.open_github_issue).toEqual({ summary: "GitHub issue created: https://github.com/owner/repo/issues/42", issueUrl: "https://github.com/owner/repo/issues/42" });
      expect(results.pr_lifecycle).toEqual({ summary: "Draft PR opened: https://github.com/owner/repo/pull/7\n\nCI watch queued; merge approval will be created after GitHub checks pass.", prUrl: "https://github.com/owner/repo/pull/7", work_item_id: pr.id, work_item_ids: [pr.id] });

      expect(gitCalls.filter((call) => call.taskType === "pr_lifecycle").some((call) => call.args.join(" ") === `push --set-upstream origin agent/work-${pr.id}` && call.cwd === "/tmp/repo")).toBe(true);
      expect(gitCalls.filter((call) => call.taskType === "pr_lifecycle").some((call) => call.args.join(" ") === "rev-parse HEAD" && call.cwd === "/tmp/repo")).toBe(true);
      expect(githubCalls.filter((call) => call.taskType === "open_github_issue").every((call) => call.binary === "gh" && call.args.includes("--repo") && call.args.includes("owner/repo"))).toBe(true);
      expect(githubCalls.filter((call) => call.taskType === "pr_lifecycle").every((call) => call.binary === "gh" && call.args.includes("--repo") && call.args.includes("owner/repo"))).toBe(true);
      expect(githubCalls.some((call) => call.taskType === "open_github_issue" && call.args[0] === "issue" && call.args[1] === "create")).toBe(true);
      expect(githubCalls.some((call) => call.taskType === "pr_lifecycle" && call.args[0] === "pr" && call.args[1] === "create" && call.args.includes("--draft") && call.args.includes(`agent/work-${pr.id}`))).toBe(true);
      expect(db.listRoleAssignmentRevisions("workspace:agent-bridge")).toHaveLength(1);
    } finally {
      db.close();
      vi.unstubAllEnvs();
    }
  });
});
