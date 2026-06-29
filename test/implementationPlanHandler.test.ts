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

## Acceptance Criteria
- Imported issue creates one work item.
- Approval is blocked until plan exists.

## Verification Commands
npm run typecheck
npm test`;

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
});
