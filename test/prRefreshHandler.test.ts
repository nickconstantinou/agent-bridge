import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createPrRefreshHandler } from "../src/handlers/prRefresh.js";

function makeDb() {
  const dbPath = join(tmpdir(), `pr-refresh-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

function makeStubs() {
  return {
    runGit: vi.fn().mockResolvedValue(""),
    runCommand: vi.fn().mockResolvedValue(""),
    prepareWorkspace: vi.fn().mockResolvedValue("/tmp/ws/work-1"),
    cleanupWorkspace: vi.fn(),
    runTests: vi.fn().mockResolvedValue({ ok: true, output: "passed" }),
  };
}

describe("createPrRefreshHandler", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => { ({ db, dbPath } = makeDb()); });
  afterEach(() => { db.close(); try { rmSync(dbPath); } catch {} });

  it("returns a handler function", () => {
    expect(typeof createPrRefreshHandler(makeStubs())).toBe("function");
  });

  it("throws when work_item_id does not exist", async () => {
    await expect(
      createPrRefreshHandler(makeStubs())(
        { work_item_id: 9999, repository: "owner/repo", branch_name: "agent/x", base_branch: "main" },
        { db, workerId: "w" },
      )
    ).rejects.toThrow(/not found|missing/i);
  });

  it("fetches and merges the base branch (no force-push)", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return "newsha\n";
      return "";
    });

    await createPrRefreshHandler(stubs)(
      { work_item_id: item.id, repository: "owner/repo", branch_name: "agent/work-1", base_branch: "main" },
      { db, workerId: "w" },
    );

    const gitCalls = stubs.runGit.mock.calls.map(([a]: [string[]]) => a[0]);
    expect(gitCalls).toContain("fetch");
    expect(gitCalls).toContain("merge");
    expect(gitCalls).toContain("push");
    // Never force-push
    const pushCalls = stubs.runGit.mock.calls.filter(([a]: [string[]]) => a[0] === "push");
    for (const [args] of pushCalls) {
      expect(args).not.toContain("--force");
      expect(args).not.toContain("--force-with-lease");
    }
  });

  it("runs the test suite after the merge", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return "newsha\n";
      return "";
    });

    await createPrRefreshHandler(stubs)(
      { work_item_id: item.id, repository: "owner/repo", branch_name: "agent/work-1", base_branch: "main" },
      { db, workerId: "w" },
    );

    expect(stubs.runTests).toHaveBeenCalledOnce();
  });

  it("updates the pending merge approval head_sha after a successful push", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 5, branch_name: "agent/work-1" });
    db.createApproval({
      approval_type: "merge_pr", requested_by: "agent", work_item_id: item.id,
      payload: { pr_number: 5, head_sha: "oldsha" },
    });
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return "newsha\n";
      return "";
    });

    await createPrRefreshHandler(stubs)(
      { work_item_id: item.id, repository: "owner/repo", branch_name: "agent/work-1", base_branch: "main" },
      { db, workerId: "w" },
    );

    const appr = db.raw.prepare(
      "SELECT payload_json FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr' AND status = 'pending'"
    ).get(item.id) as any;
    expect(JSON.parse(appr.payload_json).head_sha).toBe("newsha");
    // Also update the link pr_state back to draft (watch will re-evaluate)
    const updatedLink = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(updatedLink.pr_state).toBe("draft");
  });

  it("marks ci_failed (without pushing) when tests fail after merge", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 6, branch_name: "agent/work-2" });
    const stubs = makeStubs();
    stubs.runTests = vi.fn().mockResolvedValue({ ok: false, output: "1 test failed" });

    await createPrRefreshHandler(stubs)(
      { work_item_id: item.id, repository: "owner/repo", branch_name: "agent/work-2", base_branch: "main" },
      { db, workerId: "w" },
    );

    // Tests failed → ci_failed state, no push
    const updatedLink = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(updatedLink.pr_state).toBe("ci_failed");
    const pushCalls = stubs.runGit.mock.calls.filter(([a]: [string[]]) => a[0] === "push");
    expect(pushCalls).toHaveLength(0);
  });

  it("marks ci_failed when git merge produces a conflict", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 7, branch_name: "agent/work-3" });
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "merge") throw new Error("CONFLICT (content): Merge conflict in file.ts");
      return "";
    });

    const result = await createPrRefreshHandler(stubs)(
      { work_item_id: item.id, repository: "owner/repo", branch_name: "agent/work-3", base_branch: "main" },
      { db, workerId: "w" },
    );

    const updatedLink = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(updatedLink.pr_state).toBe("ci_failed");
    expect(result.summary).toMatch(/conflict/i);
    // No push after conflict
    const pushCalls = stubs.runGit.mock.calls.filter(([a]: [string[]]) => a[0] === "push");
    expect(pushCalls).toHaveLength(0);
  });

  it("cleans up workspace on success", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return "sha\n";
      return "";
    });

    await createPrRefreshHandler(stubs)(
      { work_item_id: item.id, repository: "owner/repo", branch_name: "agent/work-1", base_branch: "main", workspace_dir: "/ws/r" },
      { db, workerId: "w" },
    );

    expect(stubs.cleanupWorkspace).toHaveBeenCalledWith("/ws/r");
  });

  it("does not clean up workspace on merge conflict", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "merge") throw new Error("CONFLICT");
      return "";
    });

    await createPrRefreshHandler(stubs)(
      { work_item_id: item.id, repository: "owner/repo", branch_name: "agent/work-1", base_branch: "main", workspace_dir: "/ws/r" },
      { db, workerId: "w" },
    );

    expect(stubs.cleanupWorkspace).not.toHaveBeenCalled();
  });
});
