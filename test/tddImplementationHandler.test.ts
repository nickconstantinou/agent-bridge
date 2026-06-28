import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createTddImplementationHandler } from "../src/handlers/tddImplementation.js";

function makeDb() {
  const dbPath = join(tmpdir(), `tdd-impl-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

// ── Default stubs ────────────────────────────────────────────────────────────
//
// runGit answers `diff --cached --name-only` with test files for the red
// phase and production files for the green phase. runTests fails once (red
// verification) then passes (green verification).

function makeStubs() {
  let diffCalls = 0;
  return {
    runCli: vi.fn().mockResolvedValue("Done."),
    runGit: vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "diff" && args.includes("--cached")) {
        diffCalls += 1;
        return diffCalls === 1 ? "test/fix.test.ts\n" : "src/fix.ts\n";
      }
      return "";
    }),
    runTests: vi.fn()
      .mockResolvedValueOnce({ ok: false, output: "1 failing" })
      .mockResolvedValue({ ok: true, output: "Tests passed." }),
  };
}

describe("createTddImplementationHandler", () => {
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
    const handler = createTddImplementationHandler(makeStubs());
    expect(typeof handler).toBe("function");
  });

  it("throws if the work_item_id does not exist", async () => {
    const handler = createTddImplementationHandler(makeStubs());

    await expect(
      handler({ work_item_id: 9999, repository_path: "/tmp/repo" }, { db, workerId: "w" })
    ).rejects.toThrow(/not found|missing/i);
  });

  it("throws if the repo has unrelated dirty files", async () => {
    const stubs = makeStubs();
    // git status --porcelain returns non-empty output → dirty
    stubs.runGit.mockImplementation((args: string[]) => {
      if (args[0] === "status") return " M some-file.ts\n";
      return "";
    });

    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Fix timeout bug", created_by: "worker",
    });

    const handler = createTddImplementationHandler(stubs);

    await expect(
      handler({ work_item_id: item.id, repository_path: "/tmp/repo" }, { db, workerId: "w" })
    ).rejects.toThrow(/dirty|uncommitted/i);
  });

  it("creates an agent/work-<id> branch", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Fix timeout bug", created_by: "worker",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    const checkoutCall = stubs.runGit.mock.calls.find(
      ([args]: [string[]]) => args[0] === "checkout" && args.includes("-b")
    );
    expect(checkoutCall).toBeDefined();
    const branchName: string = checkoutCall![0][2];
    expect(branchName).toMatch(/^agent\/work-\d+/);
  });

  it("checks out existing branch if ci_fix is true", async () => {
    const stubs = makeStubs();
    stubs.runTests = vi.fn().mockResolvedValue({ ok: true, output: "Tests passed." });
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Fix timeout bug", created_by: "worker",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo", ci_fix: true },
      { db, workerId: "w" },
    );

    const fetchCall = stubs.runGit.mock.calls.find(
      ([args]: [string[]]) => args[0] === "fetch"
    );
    expect(fetchCall).toBeDefined();
    expect(fetchCall![0][2]).toBe(`agent/work-${item.id}`);

    const checkoutCall = stubs.runGit.mock.calls.find(
      ([args]: [string[]]) => args[0] === "checkout" && !args.includes("-b")
    );
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall![0][1]).toBe(`agent/work-${item.id}`);
  });

  it("uses CI failure logs for ci_fix and skips the normal red-test pass", async () => {
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "diff" && args.includes("--cached")) return "src/fix.ts\n";
      if (args[0] === "rev-parse") return "newheadsha\n";
      return "";
    });
    stubs.runTests = vi.fn().mockResolvedValue({ ok: true, output: "Tests passed." });
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Fix timeout bug", repository: "owner/repo", created_by: "worker",
    });

    await createTddImplementationHandler(stubs)(
      {
        work_item_id: item.id,
        repository_path: "/tmp/repo",
        ci_fix: true,
        ci_failure_log: "src/foo.test.ts failed with expected 1 got 2",
        ci_failure_summary: "Test & Typecheck failed",
      },
      { db, workerId: "w" },
    );

    expect(stubs.runCli).toHaveBeenCalledTimes(1);
    const prompt = stubs.runCli.mock.calls[0][1].at(-1) as string;
    expect(prompt).toContain("Test & Typecheck failed");
    expect(prompt).toContain("expected 1 got 2");
    expect(prompt).not.toMatch(/Step 1 of 2|Write failing tests only/);
    expect(stubs.runTests).toHaveBeenCalledTimes(1);
    expect(stubs.runGit).toHaveBeenCalledWith(["push", "origin", `agent/work-${item.id}`], "/tmp/repo");

    const watchJob = db.raw.prepare("SELECT * FROM work_jobs WHERE task_type='pr_watch'").get() as any;
    expect(watchJob).toBeDefined();
    expect(watchJob.idempotency_key).toContain("newheadsha");
  });

  it("calls runCli twice — once for red tests, once for implementation", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Fix timeout bug", body: "Requests time out after 30s.",
      created_by: "worker",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    expect(stubs.runCli).toHaveBeenCalledTimes(2);
  });

  it("includes the work item title in both CLI prompts", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Fix timeout bug", body: "Details here.",
      created_by: "worker",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    const prompts = stubs.runCli.mock.calls.map((c: any[]) => c[1].at(-1) as string);
    expect(prompts[0]).toContain("Fix timeout bug");
    expect(prompts[1]).toContain("Fix timeout bug");
  });

  it("first prompt instructs to write failing tests only — not implement", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    const redPrompt: string = stubs.runCli.mock.calls[0][1].at(-1);
    expect(redPrompt.toLowerCase()).toMatch(/failing test|red test|do not implement/i);
  });

  it("second prompt instructs to implement — not write tests", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    const greenPrompt: string = stubs.runCli.mock.calls[1][1].at(-1);
    expect(greenPrompt.toLowerCase()).toMatch(/implement|make.*pass|green/i);
  });

  it("makes two git commits — one for tests, one for implementation", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    const commits = stubs.runGit.mock.calls.filter(
      ([args]: [string[]]) => args[0] === "commit"
    );
    expect(commits).toHaveLength(2);

    const messages = commits.map(([args]: [string[]]) => args.join(" "));
    expect(messages[0].toLowerCase()).toMatch(/test/);
    expect(messages[1].toLowerCase()).toMatch(/fix|feat|implement/);
  });

  it("runs the test suite twice — confirming red fails and green passes", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    expect(stubs.runTests).toHaveBeenCalledTimes(2);
  });

  it("refuses to continue when the red tests do not fail", async () => {
    const stubs = makeStubs();
    stubs.runTests = vi.fn().mockResolvedValue({ ok: true, output: "All green" });
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await expect(
      createTddImplementationHandler(stubs)(
        { work_item_id: item.id, repository_path: "/tmp/repo" },
        { db, workerId: "w" },
      )
    ).rejects.toThrow(/did not fail|red/i);

    // No test commit may exist when red verification was never observed
    const commits = stubs.runGit.mock.calls.filter(([args]: [string[]]) => args[0] === "commit");
    expect(commits).toHaveLength(0);
  });

  it("fails when the red pass stages production files", async () => {
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "diff" && args.includes("--cached")) return "src/sneaky.ts\ntest/fix.test.ts\n";
      return "";
    });
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await expect(
      createTddImplementationHandler(stubs)(
        { work_item_id: item.id, repository_path: "/tmp/repo" },
        { db, workerId: "w" },
      )
    ).rejects.toThrow(/production|src\/sneaky\.ts/i);
  });

  it("fails when the green pass modifies test files", async () => {
    const stubs = makeStubs();
    let diffCalls = 0;
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "diff" && args.includes("--cached")) {
        diffCalls += 1;
        return diffCalls === 1 ? "test/fix.test.ts\n" : "src/fix.ts\ntest/fix.test.ts\n";
      }
      return "";
    });
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await expect(
      createTddImplementationHandler(stubs)(
        { work_item_id: item.id, repository_path: "/tmp/repo" },
        { db, workerId: "w" },
      )
    ).rejects.toThrow(/test file/i);
  });

  it("fails when final verification does not pass", async () => {
    const stubs = makeStubs();
    stubs.runTests = vi.fn().mockResolvedValue({ ok: false, output: "2 failing" });
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await expect(
      createTddImplementationHandler(stubs)(
        { work_item_id: item.id, repository_path: "/tmp/repo" },
        { db, workerId: "w" },
      )
    ).rejects.toThrow(/verification|failing/i);
  });

  it("returns a summary with branch name (no raw test output)", async () => {
    const stubs = makeStubs();
    stubs.runTests = vi.fn()
      .mockResolvedValueOnce({ ok: false, output: "1 failing" })
      .mockResolvedValue({ ok: true, output: "All 42 tests passed." });
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    const result = await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    expect(result.summary).toMatch(/agent\/work-\d+/);
    // verifyOutput is still available for callers that want the raw output
    expect(result.verifyOutput).toContain("All 42 tests passed.");
    // but summary must not flood Telegram with test runner noise
    expect(result.summary).not.toContain("All 42 tests passed.");
  });

  it("prepares a workspace when repository_path is not provided", async () => {
    const stubs = makeStubs();
    const prepareWorkspace = vi.fn().mockResolvedValue("/ws/work-1");
    const cleanupWorkspace = vi.fn();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });

    await createTddImplementationHandler({ ...stubs, prepareWorkspace, cleanupWorkspace })(
      { work_item_id: item.id },
      { db, workerId: "w" },
    );

    expect(prepareWorkspace).toHaveBeenCalledWith("owner/repo", item.id, { reuseExisting: false });
    // All git work must happen inside the workspace
    for (const call of stubs.runGit.mock.calls) {
      expect(call[1]).toBe("/ws/work-1");
    }
    // Success keeps the workspace for the pr_lifecycle push
    expect(cleanupWorkspace).not.toHaveBeenCalled();
    const prJob = db.raw.prepare("SELECT * FROM work_jobs WHERE task_type = 'pr_lifecycle'").get() as any;
    const input = JSON.parse(prJob.input_json);
    expect(input.repository_path).toBe("/ws/work-1");
    expect(input.workspace_dir).toBe("/ws/work-1");
  });

  it("preserves the workspace when the job fails so repair jobs have context", async () => {
    const stubs = makeStubs();
    stubs.runTests = vi.fn().mockResolvedValue({ ok: true, output: "green" }); // red gate trips
    const prepareWorkspace = vi.fn().mockResolvedValue("/ws/work-2");
    const cleanupWorkspace = vi.fn();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });

    await expect(
      createTddImplementationHandler({ ...stubs, prepareWorkspace, cleanupWorkspace })(
        { work_item_id: item.id },
        { db, workerId: "w" },
      )
    ).rejects.toThrow();

    expect(cleanupWorkspace).not.toHaveBeenCalled();
  });

  it("reuses an existing workspace and prior failure context for repair jobs", async () => {
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "diff" && args.includes("--cached")) return "src/fix.ts\n";
      return "";
    });
    stubs.runTests = vi.fn().mockResolvedValue({ ok: true, output: "Tests passed." });
    const prepareWorkspace = vi.fn().mockResolvedValue("/ws/work-3");
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });

    await createTddImplementationHandler({ ...stubs, prepareWorkspace })(
      {
        work_item_id: item.id,
        repair_of_job_id: 123,
        repair_context: "expected agent-bridge to be undefined",
      },
      { db, workerId: "w" },
    );

    expect(prepareWorkspace).toHaveBeenCalledWith("owner/repo", item.id, { reuseExisting: true });
    const prompt = stubs.runCli.mock.calls[0][1].at(-1) as string;
    expect(prompt).toContain("repairing a failed autonomous TDD");
    expect(prompt).toContain("expected agent-bridge to be undefined");
    expect(stubs.runTests).toHaveBeenCalledTimes(1);
  });

  it("throws when neither repository_path nor item repository is available", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await expect(
      createTddImplementationHandler({ ...stubs, prepareWorkspace: vi.fn() })(
        { work_item_id: item.id },
        { db, workerId: "w" },
      )
    ).rejects.toThrow(/repository/i);
  });

  it("transitions the work_item status to 'in_progress'", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    expect(db.getWorkItem(item.id)!.status).toBe("in_progress");
  });

  it("does not queue a pr_lifecycle job when item has no repository", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    const jobs = db.raw.prepare("SELECT * FROM work_jobs WHERE task_type = 'pr_lifecycle'").all();
    expect(jobs).toHaveLength(0);
  });

  it("queues a pr_lifecycle job when item has a repository set", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    const jobs = db.raw.prepare("SELECT * FROM work_jobs WHERE task_type = 'pr_lifecycle' AND work_item_id = ?").all(item.id) as any[];
    expect(jobs).toHaveLength(1);
    const parsed = JSON.parse(jobs[0].input_json);
    expect(parsed.branch_name).toMatch(/^agent\/work-\d+/);
    expect(parsed.repository).toBe("owner/repo");
  });

  it("propagates notify_chat_id into the queued pr_lifecycle job input", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo", notify_chat_id: 4242 },
      { db, workerId: "w" },
    );

    const jobs = db.raw.prepare("SELECT * FROM work_jobs WHERE task_type = 'pr_lifecycle' AND work_item_id = ?").all(item.id) as any[];
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].input_json).notify_chat_id).toBe(4242);
  });

  it("summary does not include raw test runner output", async () => {
    const stubs = makeStubs();
    stubs.runTests = vi.fn()
      .mockResolvedValueOnce({ ok: false, output: "1 failing" })
      .mockResolvedValue({ ok: true, output: "42 tests passed\nsome noise\nmore details\n" });

    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Fix timeout bug", created_by: "worker",
    });

    const result = await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    expect(result.summary).not.toContain("42 tests passed");
    expect(result.summary).not.toContain("some noise");
    expect(result.summary).toContain("agent/work-");
  });
});

describe("createTddImplementationHandler CLI invocation", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => { ({ db, dbPath } = makeDb()); });
  afterEach(() => { db.close(); try { rmSync(dbPath); } catch {} });

  it("passes cliExtraArgs to both CLI invocations before the prompt", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createTddImplementationHandler({ ...stubs, cliExtraArgs: ["--permission-mode", "acceptEdits"] })(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    for (const call of stubs.runCli.mock.calls) {
      const args: string[] = call[1];
      expect(args).toContain("--permission-mode");
      expect(args.indexOf("acceptEdits")).toBeLessThan(args.length - 1); // prompt stays last
      expect(args.at(-1)!.length).toBeGreaterThan(50); // prompt is the final arg
    }
  });
});
