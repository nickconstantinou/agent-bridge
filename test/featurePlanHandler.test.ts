import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createFeaturePlanHandler } from "../src/handlers/featurePlan.js";

function makeDb() {
  const dbPath = join(tmpdir(), `feature-plan-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

describe("createFeaturePlanHandler", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb());
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("returns a handler function", () => {
    const handler = createFeaturePlanHandler({ runCli: vi.fn() });
    expect(typeof handler).toBe("function");
  });

  it("calls runCli with a planning prompt containing the brief", async () => {
    const runCli = vi.fn().mockResolvedValue("## Plan\nLooks good.");
    const handler = createFeaturePlanHandler({ runCli });

    const plan = db.createFeaturePlan({ chatId: "chat-1", userId: "u", brief: "add caching layer" });

    await handler({ plan_id: plan.id }, { db, workerId: "worker" });

    expect(runCli).toHaveBeenCalledOnce();
    const prompt: string = runCli.mock.calls[0][1].at(-1);
    expect(prompt).toContain("add caching layer");
    expect(prompt.toLowerCase()).toMatch(/plan|feature|implement/i);
  });

  it("includes red test specification instructions in the prompt", async () => {
    const runCli = vi.fn().mockResolvedValue("## Plan");
    const handler = createFeaturePlanHandler({ runCli });

    const plan = db.createFeaturePlan({ chatId: "chat-1", userId: "u", brief: "add rate limiting" });

    await handler({ plan_id: plan.id }, { db, workerId: "worker" });

    const prompt: string = runCli.mock.calls[0][1].at(-1);
    expect(prompt.toLowerCase()).toMatch(/red test|failing test|tdd/i);
  });

  it("updates the feature plan status to 'ready' after generation", async () => {
    const runCli = vi.fn().mockResolvedValue("## Implementation Plan\nAll done.");
    const handler = createFeaturePlanHandler({ runCli });

    const plan = db.createFeaturePlan({ chatId: "chat-1", userId: "u", brief: "add metrics" });
    await handler({ plan_id: plan.id }, { db, workerId: "worker" });

    const updated = db.getFeaturePlan(plan.id)!;
    expect(updated.status).toBe("ready");
  });

  it("stores the plan text in scope_json after generation", async () => {
    const planText = "## Implementation Plan\n1. Write tests\n2. Implement";
    const runCli = vi.fn().mockResolvedValue(planText);
    const handler = createFeaturePlanHandler({ runCli });

    const plan = db.createFeaturePlan({ chatId: "chat-1", userId: "u", brief: "add metrics" });
    await handler({ plan_id: plan.id }, { db, workerId: "worker" });

    const updated = db.getFeaturePlan(plan.id)!;
    const scope = JSON.parse(updated.scope_json);
    expect(scope.plan_text).toContain("Implementation Plan");
  });

  it("returns a summary containing the brief", async () => {
    const runCli = vi.fn().mockResolvedValue("## Plan\nReady.");
    const handler = createFeaturePlanHandler({ runCli });

    const plan = db.createFeaturePlan({ chatId: "chat-1", userId: "u", brief: "add OAuth login" });
    const result = await handler({ plan_id: plan.id }, { db, workerId: "worker" });

    expect(result.summary).toContain("add OAuth login");
  });

  it("creates a proposed work_item of kind 'feature' after plan generation", async () => {
    const runCli = vi.fn().mockResolvedValue("## Implementation Plan\nReady to go.");
    const handler = createFeaturePlanHandler({ runCli });

    const plan = db.createFeaturePlan({ chatId: "chat-1", userId: "u", brief: "add export feature" });
    await handler({ plan_id: plan.id }, { db, workerId: "worker" });

    const items = db.listWorkItems();
    expect(items.length).toBe(1);
    expect(items[0].kind).toBe("feature");
    expect(items[0].title).toContain("add export feature");
    expect(items[0].status).toBe("proposed");
  });

  it("propagates CLI errors as thrown exceptions", async () => {
    const runCli = vi.fn().mockRejectedValue(new Error("CLI crashed"));
    const handler = createFeaturePlanHandler({ runCli });

    const plan = db.createFeaturePlan({ chatId: "chat-1", userId: "u", brief: "something" });

    await expect(
      handler({ plan_id: plan.id }, { db, workerId: "worker" })
    ).rejects.toThrow("CLI crashed");
  });

  it("throws if the plan_id does not exist in the DB", async () => {
    const handler = createFeaturePlanHandler({ runCli: vi.fn() });

    await expect(
      handler({ plan_id: 9999 }, { db, workerId: "worker" })
    ).rejects.toThrow(/not found|missing/i);
  });
});
