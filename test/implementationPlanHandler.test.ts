import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { createImplementationPlanHandler, validateImplementationPlan } from "../src/handlers/implementationPlan.js";

const strongPlan = `## Problem Summary
Fix the imported issue.

## Target Files
- src/workerBot.ts
- test/workerBot.test.ts

## Architectural Intent
Keep GitHub as source of truth and SQLite as orchestration mirror.

## Test Plan
Add failing test in test/workerBot.test.ts for imported issues.

## Implementation Phases
1. Red: add failing test.
2. Green: implement smallest route fix.

## Execution Contract

\`\`\`json
{
  "target_files": ["src/workerBot.ts"],
  "test_files": ["test/workerBot.test.ts"],
  "phase_order": ["red-test", "green-implementation", "verification"],
  "red_test_command": "npm test -- workerBot",
  "verification_command": "npm test && npm run typecheck",
  "risk_level": "medium",
  "human_decision_required": false,
  "out_of_scope": ["unrelated cleanup"],
  "notes_for_red_pass": "Add failing coverage for imported GitHub issues.",
  "notes_for_green_pass": "Implement the smallest production route fix."
}
\`\`\`

## Acceptance Criteria
- Imported issue creates one work item.
- Approval is blocked until plan exists.

## Verification Commands
npm run typecheck
npm test`;

const strongPlanWithoutContract = strongPlan.replace(
  /\n## Execution Contract[\s\S]*?(?=\n## Acceptance Criteria)/,
  "",
);

const executionContractSection = `## Execution Contract

\`\`\`json
{
  "target_files": ["src/workerBot.ts"],
  "test_files": ["test/workerBot.test.ts"],
  "phase_order": ["red-test", "green-implementation", "verification"],
  "red_test_command": "npm test -- workerBot",
  "verification_command": "npm test && npm run typecheck",
  "risk_level": "medium",
  "human_decision_required": false,
  "out_of_scope": ["unrelated cleanup"],
  "notes_for_red_pass": "Add failing coverage for imported GitHub issues.",
  "notes_for_green_pass": "Implement the smallest production route fix."
}
\`\`\``;

describe("implementation plan handler", () => {
  it("validates robust plans and rejects weak plans", () => {
    expect(validateImplementationPlan(strongPlan).valid).toBe(true);
    expect(validateImplementationPlan("Looks good. Fix it.").valid).toBe(false);
  });

  it("stores a generated implementation plan for a work item", async () => {
    const db = openDb(":memory:");
    try {
      const item = db.createWorkItem({
        kind: "feature",
        source: "github",
        repository: "owner/repo",
        title: "Imported issue",
        body: "Original issue",
        created_by: "user",
      });
      const runCli = vi.fn().mockResolvedValue(strongPlan);
      const handler = createImplementationPlanHandler({ runCli });

      const result = await handler({ work_item_id: item.id }, { db, workerId: "worker", phase: "initial", phaseData: {} });

      expect(result.work_item_id).toBe(item.id);
      expect(db.getWorkItemPlan(item.id)?.plan_text).toContain("Problem Summary");
      expect(runCli).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it("improves a weak plan automatically before storing it", async () => {
    const db = openDb(":memory:");
    try {
      const item = db.createWorkItem({
        kind: "feature",
        source: "github",
        repository: "owner/repo",
        title: "Imported issue",
        body: "Original issue",
        created_by: "user",
      });
      const runCli = vi.fn()
        .mockResolvedValueOnce("Looks good. Fix it.")
        .mockResolvedValueOnce(strongPlan);
      const handler = createImplementationPlanHandler({ runCli });

      await handler({ work_item_id: item.id }, { db, workerId: "worker", phase: "initial", phaseData: {} });

      expect(runCli).toHaveBeenCalledTimes(2);
      expect(runCli.mock.calls[1][1].at(-1)).toContain("Improve this implementation plan");
      expect(db.getWorkItemPlan(item.id)?.plan_text).toBe(strongPlan);
    } finally {
      db.close();
    }
  });

  it("repairs a missing execution contract after the full-plan improvement remains noncompliant", async () => {
    const db = openDb(":memory:");
    try {
      const item = db.createWorkItem({
        kind: "feature",
        source: "github",
        repository: "owner/repo",
        title: "Imported issue",
        body: "Original issue",
        created_by: "user",
      });
      const runCli = vi.fn()
        .mockResolvedValueOnce(strongPlanWithoutContract)
        .mockResolvedValueOnce(strongPlanWithoutContract)
        .mockResolvedValueOnce(executionContractSection);
      const handler = createImplementationPlanHandler({ runCli });

      await handler({ work_item_id: item.id }, { db, workerId: "worker", phase: "initial", phaseData: {} });

      expect(runCli).toHaveBeenCalledTimes(3);
      expect(runCli.mock.calls[2][1].at(-1)).toContain("Return only the repaired Execution Contract section");
      const stored = db.getWorkItemPlan(item.id)!;
      expect(stored.plan_text).toBe(`${strongPlanWithoutContract}\n\n${executionContractSection}`);
      expect(JSON.parse(stored.quality_json).execution_contract.target_files).toEqual(["src/workerBot.ts"]);
    } finally {
      db.close();
    }
  });

  it("continues approved work after plan generation without a second approval click", async () => {
    const db = openDb(":memory:");
    try {
      const item = db.createWorkItem({
        kind: "feature",
        source: "github",
        repository: "owner/repo",
        title: "Imported issue",
        body: "Original issue",
        created_by: "user",
      });
      const runCli = vi.fn().mockResolvedValue(strongPlan);
      const handler = createImplementationPlanHandler({ runCli });

      await handler(
        { work_item_id: item.id, approve_after_plan: true, notify_chat_id: 10 },
        { db, workerId: "worker", phase: "initial", phaseData: {} },
      );

      expect(db.getWorkItem(item.id)!.status).toBe("approved");
      expect(db.listWorkJobs().map(j => j.task_type)).toEqual(["open_github_issue", "tdd_implementation"]);
      const tdd = db.listWorkJobs().find(j => j.task_type === "tdd_implementation")!;
      expect(JSON.parse(tdd.input_json).notify_chat_id).toBe(10);
    } finally {
      db.close();
    }
  });

  it("refreshes linked GitHub issue content before generating the plan", async () => {
    const db = openDb(":memory:");
    try {
      const item = db.createWorkItem({
        kind: "feature",
        source: "github",
        repository: "owner/repo",
        title: "Stale title",
        body: "Stale body",
        created_by: "user",
      });
      db.linkGithubIssue({ work_item_id: item.id, repository: "owner/repo", issue_number: 42 });
      const runCommand = vi.fn(async (_binary: string, args: string[]) => {
        if (args.includes("view")) {
          return JSON.stringify({ title: "Fresh GitHub title", body: "Fresh GitHub body" });
        }
        return "";
      });
      const runCli = vi.fn().mockResolvedValue(strongPlan);
      const handler = createImplementationPlanHandler({ runCli, runCommand });

      await handler({ work_item_id: item.id }, { db, workerId: "worker", phase: "initial", phaseData: {} });

      const prompt = runCli.mock.calls[0][1].at(-1) as string;
      expect(prompt).toContain("Fresh GitHub title");
      expect(prompt).toContain("Fresh GitHub body");
      expect(prompt).not.toContain("Stale body");
      const updated = db.getWorkItem(item.id)!;
      expect(updated.title).toBe("Fresh GitHub title");
      expect(updated.body).toBe("Fresh GitHub body");
      expect(runCommand).toHaveBeenCalledWith("gh", [
        "issue", "view", "42",
        "--repo", "owner/repo",
        "--json", "title,body,state",
      ]);
    } finally {
      db.close();
    }
  });
});
