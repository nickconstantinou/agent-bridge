import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadRoleAssignmentConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { executeNextJob } from "../src/jobExecutor.js";
import {
  handleWorkerCommand,
  type WorkerKeyboardMessageResult,
} from "../src/workerBot.js";
import { resolveWorkerCliPolicy } from "../src/workerCliPolicy.js";

function roleConfig() {
  return loadRoleAssignmentConfig({
    WORKER_ROLE_ASSIGNMENT_SCOPE: "workspace:agent-bridge",
    WORKER_ROLE_ASSIGNMENTS_JSON: JSON.stringify([
      {
        role: "technical_lead",
        selection: "manual",
        primary: { cli: "claude", model: "claude-fable-5" },
        fallbacks: [{ cli: "codex", model: "gpt-5.6-sol" }],
      },
      {
        role: "code_worker",
        selection: "manual",
        primary: { cli: "claude", model: "claude-sonnet-5" },
        fallbacks: [{ cli: "codex", model: "gpt-5.6-sol" }],
      },
      {
        role: "documentation_steward",
        selection: "manual",
        primary: { cli: "codex", model: "gpt-5.6-sol" },
        fallbacks: [],
      },
    ]),
  })!;
}

const legacyEnv = {
  WORKER_CLI_CHAIN: "antigravity,codex,claude",
  WORKER_CODE_CLI_CHAIN: "codex,claude",
  WORKER_SCRIBE_CLI_CHAIN: "antigravity,claude,codex",
} as NodeJS.ProcessEnv;

type RouteFixture = {
  owner: "scribe" | "code" | "github" | "git_github";
  command: string;
  chain: string[];
};

describe("dormant role assignment compatibility", () => {
  it("preserves the existing /chain response when no role assignment revision exists", async () => {
    const db = openDb(":memory:");
    const policy = resolveWorkerCliPolicy(legacyEnv);
    try {
      const result = await handleWorkerCommand("/chain", {
        workerEnabled: true,
        cliChain: policy.interactiveChain,
        cliPolicy: policy,
        db,
        roleScopeKey: "workspace:agent-bridge",
      });

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("keyboard_message");
      expect(result!.text).toBe(
        "[worker CLI chain]\n\n" +
        "Execution order: antigravity → codex → claude\n\n" +
        "On failure, the next CLI in the chain is tried. Merge approval always requires your explicit confirmation.",
      );
    } finally {
      db.close();
    }
  });

  it("reports explicit assignments as configured dormant while legacy chains remain effective", async () => {
    const db = openDb(":memory:");
    const config = roleConfig();
    const policy = resolveWorkerCliPolicy(legacyEnv);
    try {
      const revision = db.createRoleAssignmentRevision(config);
      const result = await handleWorkerCommand("/chain", {
        workerEnabled: true,
        cliChain: policy.interactiveChain,
        cliPolicy: policy,
        db,
        roleScopeKey: config.scopeKey,
      });

      expect(result).not.toBeNull();
      expect(result!.kind).toBe("keyboard_message");
      const text = (result as WorkerKeyboardMessageResult).text;
      expect(text).toContain("Role assignments: configured_dormant");
      expect(text).toContain(`Desired revision: ${revision.revision}`);
      expect(text).toContain("Configuration source: environment");
      expect(text).toContain("technical_lead: claude/claude-fable-5");
      expect(text).toContain("code_worker: claude/claude-sonnet-5");
      expect(text).toContain("documentation_steward: codex/gpt-5.6-sol");
      expect(text).toContain("Role routing: disabled");
      expect(text).toContain("Effective legacy interactive chain: antigravity → codex → claude");
      expect(text).toContain("Effective legacy code chain: codex → claude");
      expect(text).toContain("Effective legacy scribe chain: antigravity → claude → codex");
      expect(text).not.toMatch(/role assignments?: effective/i);
      expect(text).not.toMatch(/token|api[_-]?key|secret|prompt_text|repository_content/i);
    } finally {
      db.close();
    }
  });

  it("ignores persisted role assignments for every existing handler while routing is disabled", async () => {
    const db = openDb(":memory:");
    const config = roleConfig();
    const policyBefore = resolveWorkerCliPolicy(legacyEnv);
    const policyAfter = resolveWorkerCliPolicy({
      ...legacyEnv,
      WORKER_ROLE_ASSIGNMENTS_JSON: JSON.stringify(config.assignments),
      WORKER_ROLE_ASSIGNMENT_SCOPE: config.scopeKey,
    });
    expect(policyAfter).toEqual(policyBefore);

    const desiredRevision = db.createRoleAssignmentRevision(config);
    const source = readFileSync(new URL("../src/index-worker.ts", import.meta.url), "utf8");
    const handlerMapStart = source.indexOf("const jobExecutor = startJobExecutorLoop({");
    const handlerMapEnd = source.indexOf("  sendMessage:", handlerMapStart);
    expect(handlerMapStart).toBeGreaterThanOrEqual(0);
    expect(handlerMapEnd).toBeGreaterThan(handlerMapStart);
    const productionHandlerMap = source.slice(handlerMapStart, handlerMapEnd);

    const expectedRoutes: Record<string, RouteFixture> = {
      defect_scan: {
        owner: "scribe",
        command: policyBefore.scribeChain[0],
        chain: policyBefore.scribeChain,
      },
      feature_plan: {
        owner: "scribe",
        command: policyBefore.scribeChain[0],
        chain: policyBefore.scribeChain,
      },
      implementation_plan: {
        owner: "scribe",
        command: policyBefore.scribeChain[0],
        chain: policyBefore.scribeChain,
      },
      tdd_implementation: {
        owner: "code",
        command: policyBefore.codeChain[0],
        chain: policyBefore.codeChain,
      },
      orchestrated_task: {
        owner: "code",
        command: policyBefore.codeChain[0],
        chain: policyBefore.codeChain,
      },
      open_github_issue: {
        owner: "github",
        command: "runWorkerCommand",
        chain: [],
      },
      pr_lifecycle: {
        owner: "git_github",
        command: "runGit/runWorkerCommand",
        chain: [],
      },
    };

    expect(productionHandlerMap).toContain("defect_scan: createDefectScanHandler");
    expect(productionHandlerMap).toContain("feature_plan: createFeaturePlanHandler");
    expect(productionHandlerMap).toContain("implementation_plan: createImplementationPlanHandler");
    expect(productionHandlerMap).toContain("tdd_implementation: createTddImplementationHandler");
    expect(productionHandlerMap).toContain("orchestrated_task: createOrchestratedTaskHandler");
    expect(productionHandlerMap).toContain("open_github_issue: createGithubIssueHandler");
    expect(productionHandlerMap).toContain("pr_lifecycle: createPrLifecycleHandler");
    expect(productionHandlerMap).toMatch(/defect_scan:[\s\S]*?runCliWithFallback\([^\n]+scribeCliChain/);
    expect(productionHandlerMap).toMatch(/feature_plan:[\s\S]*?runCliWithFallback\([^\n]+scribeCliChain/);
    expect(productionHandlerMap).toMatch(/implementation_plan:[\s\S]*?runCliWithFallback\([^\n]+scribeCliChain/);
    expect(productionHandlerMap).toMatch(/tdd_implementation:[\s\S]*?runCliWithFallback\([^\n]+codeCliChain/);
    expect(productionHandlerMap).toMatch(/orchestrated_task:[\s\S]*?runCliWithFallback\([^\n]+codeCliChain/);
    expect(productionHandlerMap).toMatch(/open_github_issue:[\s\S]*?runWorkerCommand/);
    expect(productionHandlerMap).toMatch(/pr_lifecycle:[\s\S]*?runWorkerCommand/);
    expect(productionHandlerMap).not.toMatch(/roleAssignment|role_assignment|AgentRole|configured_dormant/);

    const observations: Array<{ taskType: string; route: RouteFixture; marker: string }> = [];
    const handlers = Object.fromEntries(
      Object.entries(expectedRoutes).map(([taskType, route]) => [
        taskType,
        vi.fn(async (input: Record<string, unknown>) => {
          const marker = String(input.marker);
          observations.push({ taskType, route, marker });
          return { taskType, route, marker };
        }),
      ]),
    );

    try {
      for (const [taskType, route] of Object.entries(expectedRoutes)) {
        const marker = `baseline:${taskType}`;
        const job = db.createWorkJob({
          task_type: taskType,
          idempotency_key: `dormant-compatibility:${taskType}`,
          input_json: { marker },
          max_attempts: 1,
        });

        const execution = await executeNextJob({
          db,
          workerId: "dormant-compatibility-worker",
          handlers,
          targetJobId: job.id,
          notify: vi.fn(),
        });

        expect(execution).toEqual({ jobId: job.id });
        const completed = db.getWorkJob(job.id)!;
        expect(completed.status).toBe("completed");
        expect(JSON.parse(completed.result_json!)).toEqual({ taskType, route, marker });
      }

      expect(observations).toEqual(
        Object.entries(expectedRoutes).map(([taskType, route]) => ({
          taskType,
          route,
          marker: `baseline:${taskType}`,
        })),
      );
      expect(db.listRoleAssignmentRevisions(config.scopeKey)).toEqual([desiredRevision]);
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM role_assignment_revisions").get())
        .toEqual({ count: 1 });
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'role_%' ORDER BY name").all())
        .toEqual([
          { name: "role_assignment_revisions" },
          { name: "role_assignments" },
        ]);
    } finally {
      db.close();
    }
  });
});
