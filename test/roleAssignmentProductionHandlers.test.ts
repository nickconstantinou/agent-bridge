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
import { executeNextJob, type JobHandler } from "../src/jobExecutor.js";
import { resolveWorkerCliPolicy } from "../src/workerCliPolicy.js";

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
    const db = openDb(":memory:");
    persistDormantAssignment(db);
    const policy = resolveWorkerCliPolicy(env);
    const bots = loadBotsConfig(env);
    const cliCalls: Array<{ owner: string; command: string }> = [];
    const gitCalls: string[][] = [];
    const githubCalls: string[][] = [];
    let tddDiff = 0;
    const scribe = vi.fn(async (command: string) => { cliCalls.push({ owner: "scribe", command }); return "No defects found."; });
    const planCli = vi.fn(async (command: string) => { cliCalls.push({ owner: "scribe", command }); return validPlan; });
    const code = vi.fn(async (command: string) => { cliCalls.push({ owner: "code", command }); return "Done."; });
    const runGit = vi.fn(async (args: string[]) => {
      gitCalls.push(args);
      if (args[0] === "diff" && args.includes("--cached")) return ++tddDiff === 1 ? "test/fix.test.ts\n" : "src/fix.ts\n";
      if (args[0] === "rev-parse") return "abcdef1234567890\n";
      return "";
    });
    const runGithub = vi.fn(async (_binary: string, args: string[]) => {
      githubCalls.push(args);
      if (args[0] === "issue" && args[1] === "create") return "https://github.com/owner/repo/issues/42";
      if (args[0] === "pr" && args[1] === "create") return "https://github.com/owner/repo/pull/7";
      return "";
    });
    const item = () => db.createWorkItem({ kind: "feature", source: "telegram", repository: "owner/repo", title: "Compatibility", body: "bounded", created_by: "worker" });
    try {
      await executeDurably(db, "defect_scan", createDefectScanHandler({ runCli: scribe, command: bots.antigravity.command }), { repository: "owner/repo" });
      const feature = db.createFeaturePlan({ chatId: "chat", userId: "user", brief: "Compatibility" });
      await executeDurably(db, "feature_plan", createFeaturePlanHandler({ runCli: scribe, command: bots.antigravity.command }), { plan_id: feature.id, repository: "owner/repo" });
      const planned = item();
      await executeDurably(db, "implementation_plan", createImplementationPlanHandler({ runCli: planCli, command: bots.antigravity.command, runCommand: runGithub, resolveRepoPath: () => "/tmp/repo" }), { work_item_id: planned.id });
      const tdd = item();
      const tests = vi.fn().mockResolvedValueOnce({ ok: false, output: "red" }).mockResolvedValue({ ok: true, output: "green" });
      await executeDurably(db, "tdd_implementation", createTddImplementationHandler({ runCli: code, command: bots.codex.command, runGit, runTests: tests }), { work_item_id: tdd.id, repository_path: "/tmp/repo" });
      tddDiff = 0;
      const orchestrated = item();
      await executeDurably(db, "orchestrated_task", createOrchestratedTaskHandler({ runCli: code, command: bots.codex.command, runGit, runTests: vi.fn().mockResolvedValue({ ok: true, output: "green" }) }), { work_item_id: orchestrated.id, repository_path: "/tmp/repo" });
      const issue = item();
      await executeDurably(db, "open_github_issue", createGithubIssueHandler({ runCommand: runGithub }), { work_item_id: issue.id, repository: "owner/repo" });
      const pr = item();
      await executeDurably(db, "pr_lifecycle", createPrLifecycleHandler({ runGit, runCommand: runGithub }), { work_item_id: pr.id, branch_name: `agent/work-${pr.id}`, repository: "owner/repo", repository_path: "/tmp/repo" });

      expect(policy).toEqual({ interactiveChain: ["antigravity", "codex", "claude"], codeChain: ["codex", "claude"], scribeChain: ["antigravity", "claude", "codex"] });
      expect(bots.antigravity.modelPreference).toEqual(["gemini-primary", "gemini-fallback"]);
      expect(bots.codex.modelPreference).toEqual(["gpt-primary", "gpt-fallback"]);
      expect(cliCalls.filter((call) => call.owner === "scribe").every((call) => call.command === "agy-controlled")).toBe(true);
      expect(cliCalls.filter((call) => call.owner === "code").every((call) => call.command === "codex-controlled")).toBe(true);
      expect(gitCalls.some((args) => args[0] === "push")).toBe(true);
      expect(githubCalls.some((args) => args[0] === "issue" && args[1] === "create")).toBe(true);
      expect(githubCalls.some((args) => args[0] === "pr" && args[1] === "create")).toBe(true);
      expect(db.listRoleAssignmentRevisions("workspace:agent-bridge")).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
