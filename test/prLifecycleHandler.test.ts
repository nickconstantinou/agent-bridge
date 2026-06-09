import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createPrLifecycleHandler } from "../src/handlers/prLifecycle.js";

function makeDb() {
  const dbPath = join(tmpdir(), `pr-lifecycle-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

function makeStubs() {
  return {
    runGit: vi.fn().mockReturnValue(""),
    runCommand: vi.fn().mockResolvedValue("https://github.com/owner/repo/pull/7"),
  };
}

describe("createPrLifecycleHandler", () => {
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
    const handler = createPrLifecycleHandler(makeStubs());
    expect(typeof handler).toBe("function");
  });

  it("throws if work_item_id does not exist", async () => {
    const handler = createPrLifecycleHandler(makeStubs());

    await expect(
      handler(
        { work_item_id: 9999, branch_name: "agent/work-9999", repository: "owner/repo" },
        { db, workerId: "w" },
      )
    ).rejects.toThrow(/not found|missing/i);
  });

  it("pushes the branch to origin via git", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Fix timeout bug", created_by: "worker",
    });

    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    const pushCall = stubs.runGit.mock.calls.find(
      ([args]: [string[]]) => args[0] === "push"
    );
    expect(pushCall).toBeDefined();
    expect(pushCall![0]).toContain(`agent/work-${item.id}`);
  });

  it("calls runCommand with gh pr create and draft flag", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Fix timeout bug", created_by: "worker",
    });

    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    expect(stubs.runCommand).toHaveBeenCalledOnce();
    const [binary, args]: [string, string[]] = stubs.runCommand.mock.calls[0];
    expect(binary).toBe("gh");
    expect(args).toContain("pr");
    expect(args).toContain("create");
    expect(args).toContain("--draft");
  });

  it("includes the work item title in the PR title arg", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Fix timeout bug", created_by: "worker",
    });

    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    const args: string[] = stubs.runCommand.mock.calls[0][1];
    const titleIdx = args.indexOf("--title");
    expect(titleIdx).toBeGreaterThan(-1);
    expect(args[titleIdx + 1]).toContain("Fix timeout bug");
  });

  it("stores a github_link record with the PR number", async () => {
    const stubs = makeStubs();
    stubs.runCommand.mockResolvedValue("https://github.com/owner/repo/pull/42");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    const links = db.raw.prepare("SELECT * FROM github_links WHERE work_item_id = ?").all(item.id) as any[];
    const prLink = links.find((l: any) => l.pr_number === 42);
    expect(prLink).toBeDefined();
    expect(prLink.repository).toBe("owner/repo");
  });

  it("returns a summary with the PR URL", async () => {
    const stubs = makeStubs();
    stubs.runCommand.mockResolvedValue("https://github.com/owner/repo/pull/5");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    const result = await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    expect(result.summary).toContain("https://github.com/owner/repo/pull/5");
    expect(result.prUrl).toBe("https://github.com/owner/repo/pull/5");
  });

  it("transitions work_item to 'blocked' (awaiting merge approval)", async () => {
    const stubs = makeStubs();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    expect(db.getWorkItem(item.id)!.status).toBe("blocked");
  });

  it("creates a merge_pr approval record", async () => {
    const stubs = makeStubs();
    stubs.runCommand.mockResolvedValue("https://github.com/owner/repo/pull/3");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    const approvals = db.raw.prepare(
      "SELECT * FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr'"
    ).all(item.id) as any[];
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe("pending");
  });
});
