import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadRoleAssignmentConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
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

  it("ignores persisted role assignments for every existing handler while routing is disabled", () => {
    const config = roleConfig();
    const policyBefore = resolveWorkerCliPolicy(legacyEnv);
    const policyAfter = resolveWorkerCliPolicy({
      ...legacyEnv,
      WORKER_ROLE_ASSIGNMENTS_JSON: JSON.stringify(config.assignments),
      WORKER_ROLE_ASSIGNMENT_SCOPE: config.scopeKey,
    });
    expect(policyAfter).toEqual(policyBefore);

    const source = readFileSync(new URL("../src/index-worker.ts", import.meta.url), "utf8");
    const handlerMapStart = source.indexOf("const jobExecutor = startJobExecutorLoop({");
    const handlerMapEnd = source.indexOf("  sendMessage:", handlerMapStart);
    expect(handlerMapStart).toBeGreaterThanOrEqual(0);
    expect(handlerMapEnd).toBeGreaterThan(handlerMapStart);
    const handlerMap = source.slice(handlerMapStart, handlerMapEnd);

    expect(handlerMap).toContain("defect_scan: createDefectScanHandler");
    expect(handlerMap).toContain("feature_plan: createFeaturePlanHandler");
    expect(handlerMap).toContain("implementation_plan: createImplementationPlanHandler");
    expect(handlerMap).toContain("tdd_implementation: createTddImplementationHandler");
    expect(handlerMap).toContain("orchestrated_task: createOrchestratedTaskHandler");
    expect(handlerMap).toContain("open_github_issue: createGithubIssueHandler");
    expect(handlerMap).toContain("pr_lifecycle: createPrLifecycleHandler");

    expect(handlerMap).toMatch(/defect_scan:[\s\S]*?runCliWithFallback\([^\n]+scribeCliChain/);
    expect(handlerMap).toMatch(/feature_plan:[\s\S]*?runCliWithFallback\([^\n]+scribeCliChain/);
    expect(handlerMap).toMatch(/implementation_plan:[\s\S]*?runCliWithFallback\([^\n]+scribeCliChain/);
    expect(handlerMap).toMatch(/tdd_implementation:[\s\S]*?runCliWithFallback\([^\n]+codeCliChain/);
    expect(handlerMap).toMatch(/orchestrated_task:[\s\S]*?runCliWithFallback\([^\n]+codeCliChain/);
    expect(handlerMap).toMatch(/open_github_issue:[\s\S]*?runWorkerCommand/);
    expect(handlerMap).toMatch(/pr_lifecycle:[\s\S]*?runWorkerCommand/);
    expect(handlerMap).not.toMatch(/roleAssignment|role_assignment|AgentRole|configured_dormant/);
  });
});
