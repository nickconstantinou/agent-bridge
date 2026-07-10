import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createOrchestratedTaskHandler } from "../src/handlers/orchestratedTask.js";

function makeDb() {
  const dbPath = join(tmpdir(), `orchestrated-task-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

function makeStubs() {
  return {
    runCli: vi.fn().mockResolvedValue("1. Inspect\n2. Edit\n3. Test"),
    runGit: vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "diff" && args.includes("--cached")) return "src/fix.ts\n";
      return "";
    }),
    runTests: vi.fn().mockResolvedValue({ ok: true, output: "Tests passed." }),
  };
}

describe("createOrchestratedTaskHandler", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb());
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("allows orchestrated_task jobs in the database schema", () => {
    const job = db.createWorkJob({
      task_type: "orchestrated_task",
      idempotency_key: "orch:schema:1",
    });

    expect(job.task_type).toBe("orchestrated_task");
  });

  it("plans first and continues to executing with checkpointed phase data", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler({
      ...stubs,
      commands: { codex: "codex", claude: "claude", antigravity: "agy" },
    })(
      { work_item_id: item.id, repository_path: "/tmp/repo", preferred_cli: "codex" },
      { db, workerId: "w", phase: "initial", phaseData: {} },
    );

    expect(result.status).toBe("continue");
    expect(result.phase).toBe("executing");
    expect(result.phaseData).toMatchObject({
      workItemId: item.id,
      repoPath: "/tmp/repo",
      branchName: `agent/work-${item.id}`,
      preferredCli: "codex",
    });
    expect(stubs.runCli.mock.calls[0][0]).toBe("codex");
    expect(stubs.runCli.mock.calls[0][1].at(-1)).toMatch(/Do not edit files/i);
  });

  it("folds an advisor plan checkpoint into phase data when configured", async () => {
    const stubs = makeStubs();
    const advisorCheckpoint = vi.fn().mockResolvedValue("Advisor: narrow the migration and add rollback coverage.");
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler({ ...stubs, advisorCheckpoint })(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w", phase: "initial", phaseData: {} },
    );

    expect(advisorCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ mode: "plan", taskKey: `work-item:${item.id}` }));
    expect(result.phaseData).toMatchObject({ advisorPlan: expect.stringContaining("rollback") });
  });

  it("runs a PR-readiness advisor checkpoint after tests pass", async () => {
    const stubs = makeStubs();
    const advisorCheckpoint = vi.fn().mockResolvedValue("Advisor: ready for review.");
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    await createOrchestratedTaskHandler({ ...stubs, advisorCheckpoint })(
      { work_item_id: item.id },
      { db, workerId: "w", phase: "verifying", phaseData: {
        workItemId: item.id, repoPath: "/tmp/repo", branchName: `agent/work-${item.id}`, plan: "Plan",
      } },
    );

    expect(advisorCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      mode: "pr_ready", taskKey: `work-item:${item.id}`, testOutput: "Tests passed.",
    }));
  });

  it("fails closed when a job requires an unavailable advisor", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Sensitive migration", created_by: "worker",
    });

    await expect(createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo", advisor_required: true },
      { db, workerId: "w", phase: "initial", phaseData: {} },
    )).rejects.toThrow(/advisor required but disabled/i);
  });

  it("executes from the stored plan, commits changes, then continues to verifying", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id },
      {
        db, workerId: "w", phase: "executing",
        phaseData: {
          workItemId: item.id,
          repoPath: "/tmp/repo",
          branchName: `agent/work-${item.id}`,
          plan: "1. Edit files",
          preferredCli: "claude",
        },
      },
    );

    expect(result.status).toBe("continue");
    expect(result.phase).toBe("verifying");
    expect(stubs.runCli.mock.calls[0][0]).toBe("claude");
    expect(stubs.runGit.mock.calls.some(([args]: [string[]]) => args[0] === "commit")).toBe(true);
    expect(db.getWorkItem(item.id)!.status).toBe("in_progress");
  });

  it("rejects antigravity as preferred_cli for code-writing phases", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    await expect(createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo", preferred_cli: "antigravity" },
      { db, workerId: "w", phase: "initial", phaseData: {} },
    )).rejects.toThrow(/not allowed.*orchestrated_task/i);
  });

  it("fails executing when no files are staged", async () => {
    const stubs = makeStubs();
    stubs.runGit.mockImplementation((args: string[]) => {
      if (args[0] === "diff" && args.includes("--cached")) return "";
      return "";
    });
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    await expect(createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id },
      {
        db, workerId: "w", phase: "executing",
        phaseData: {
          workItemId: item.id,
          repoPath: "/tmp/repo",
          branchName: `agent/work-${item.id}`,
          plan: "1. Edit files",
        },
      },
    )).rejects.toThrow(/staged no changes/i);
  });

  it("verifies and queues pr_lifecycle with verification output", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    const result = await createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id, notify_chat_id: 123 },
      {
        db, workerId: "w", phase: "verifying",
        phaseData: {
          workItemId: item.id,
          repoPath: "/tmp/repo",
          branchName: `agent/work-${item.id}`,
          plan: "1. Edit files",
        },
      },
    );

    expect(result.summary).toContain("Orchestrated task complete");
    const jobs = db.listWorkJobs().filter(j => j.task_type === "pr_lifecycle");
    expect(jobs).toHaveLength(1);
    const input = JSON.parse(jobs[0].input_json);
    expect(input).toMatchObject({
      work_item_id: item.id,
      branch_name: `agent/work-${item.id}`,
      repository: "owner/repo",
      repository_path: "/tmp/repo",
      notify_chat_id: 123,
      verify_output: "Tests passed.",
    });
  });

  it("does not queue pr_lifecycle when verification fails", async () => {
    const stubs = makeStubs();
    stubs.runTests.mockResolvedValue({ ok: false, output: "1 failing" });
    const item = db.createWorkItem({
      kind: "feature", source: "telegram", repository: "owner/repo",
      title: "Add orchestration", created_by: "worker",
    });

    await expect(createOrchestratedTaskHandler(stubs)(
      { work_item_id: item.id },
      {
        db, workerId: "w", phase: "verifying",
        phaseData: {
          workItemId: item.id,
          repoPath: "/tmp/repo",
          branchName: `agent/work-${item.id}`,
        },
      },
    )).rejects.toThrow(/verification failed/i);

    expect(db.listWorkJobs().filter(j => j.task_type === "pr_lifecycle")).toHaveLength(0);
  });
});
