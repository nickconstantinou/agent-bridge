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

function makeStubs() {
  return {
    runCli: vi.fn().mockResolvedValue("Done."),
    runGit: vi.fn().mockReturnValue(""),
    runVerify: vi.fn().mockReturnValue("Tests passed."),
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

  it("calls runVerify after implementation commit", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    expect(stubs.runVerify).toHaveBeenCalledOnce();
  });

  it("returns a summary with branch name and verification result", async () => {
    const stubs = makeStubs();
    stubs.runVerify.mockReturnValue("All 42 tests passed.");
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    const result = await createTddImplementationHandler(stubs)(
      { work_item_id: item.id, repository_path: "/tmp/repo" },
      { db, workerId: "w" },
    );

    expect(result.summary).toMatch(/agent\/work-\d+/);
    expect(result.summary).toContain("All 42 tests passed.");
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
});
