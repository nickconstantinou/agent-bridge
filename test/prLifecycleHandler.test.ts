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

    const createCall = stubs.runCommand.mock.calls.find(([, args]: [string, string[]]) =>
      args.includes("create")
    );
    expect(createCall).toBeDefined();
    const [binary, args]: [string, string[]] = createCall!;
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

  it("does not create a merge_pr approval before GitHub CI passes", async () => {
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
    expect(approvals).toHaveLength(0);
  });

  it("marks the PR ci_pending and queues a head-specific pr_watch job", async () => {
    const stubs = makeStubs();
    stubs.runGit.mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return "abc123def456\n";
      return "";
    });
    stubs.runCommand.mockResolvedValue("https://github.com/owner/repo/pull/9");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    const link = db.raw.prepare(
      "SELECT * FROM github_links WHERE work_item_id = ? AND pr_number = 9"
    ).get(item.id) as any;
    expect(link.pr_state).toBe("ci_pending");
    expect(link.commit_sha).toBe("abc123def456");

    const watchJob = db.raw.prepare(
      "SELECT * FROM work_jobs WHERE task_type = 'pr_watch' AND idempotency_key = ?"
    ).get("pr_watch:pr:9:abc123def456") as any;
    expect(watchJob).toBeDefined();
  });

  it("cleans up the workspace after the PR is opened", async () => {
    const stubs = makeStubs();
    const cleanupWorkspace = vi.fn();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await createPrLifecycleHandler({ ...stubs, cleanupWorkspace })(
      {
        work_item_id: item.id, branch_name: `agent/work-${item.id}`,
        repository: "owner/repo", repository_path: "/ws/work-1", workspace_dir: "/ws/work-1",
      },
      { db, workerId: "w" },
    );

    expect(cleanupWorkspace).toHaveBeenCalledWith("/ws/work-1");
  });

  it("leaves the workspace in place when the push fails", async () => {
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "push") throw new Error("remote rejected");
      return "";
    });
    const cleanupWorkspace = vi.fn();
    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await expect(
      createPrLifecycleHandler({ ...stubs, cleanupWorkspace })(
        {
          work_item_id: item.id, branch_name: `agent/work-${item.id}`,
          repository: "owner/repo", repository_path: "/ws/work-2", workspace_dir: "/ws/work-2",
        },
        { db, workerId: "w" },
      )
    ).rejects.toThrow(/remote rejected/);

    expect(cleanupWorkspace).not.toHaveBeenCalled();
  });
});

// ── Phase 9 Slice 19: idempotent create-or-update ────────────────────────────

describe("createPrLifecycleHandler — idempotent retries", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => { ({ db, dbPath } = makeDb()); });
  afterEach(() => { db.close(); try { rmSync(dbPath); } catch {} });

  it("reuses an existing PR link instead of calling gh pr create again", async () => {
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return "newsha999\n";
      return "";
    });
    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
    });
    db.linkGithubPr({
      work_item_id: item.id, repository: "owner/repo",
      pr_number: 3, branch_name: `agent/work-${item.id}`,
    });
    const result = await createPrLifecycleHandler(stubs)(
      {
        work_item_id: item.id, branch_name: `agent/work-${item.id}`,
        repository: "owner/repo", repository_path: "/ws/x",
      },
      { db, workerId: "w" },
    );

    // No second create call
    const createCall = stubs.runCommand.mock.calls.find(([, args]: [string, string[]]) => args.includes("create"));
    expect(createCall).toBeUndefined();
    // Branch still pushed
    const pushCall = stubs.runGit.mock.calls.find(([args]: [string[]]) => args[0] === "push");
    expect(pushCall).toBeDefined();
    // No merge approval is created/refreshed until pr_watch observes green CI
    const approvals = db.raw.prepare(
      "SELECT payload_json FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr' AND status = 'pending'"
    ).all(item.id) as any[];
    expect(approvals).toHaveLength(0);
    const link = db.raw.prepare("SELECT * FROM github_links WHERE work_item_id = ?").get(item.id) as any;
    expect(link.pr_state).toBe("ci_pending");
    expect(link.commit_sha).toBe("newsha999");
    expect(result.summary).toMatch(/refreshed|updated|existing/i);
  });

  it("recovers the PR number when gh pr create says one already exists", async () => {
    const stubs = makeStubs();
    stubs.runCommand = vi.fn().mockRejectedValue(new Error(
      'a pull request for branch "agent/work-9" into branch "main" already exists:\nhttps://github.com/owner/repo/pull/7'
    ));
    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
    });

    const result = await createPrLifecycleHandler(stubs)(
      {
        work_item_id: item.id, branch_name: "agent/work-9",
        repository: "owner/repo", repository_path: "/ws/x",
      },
      { db, workerId: "w" },
    );

    // Link recorded from the URL in the error message
    const link = db.raw.prepare(
      "SELECT * FROM github_links WHERE repository = 'owner/repo' AND pr_number = 7"
    ).get() as any;
    expect(link).toBeDefined();
    // Merge approval is deferred until CI passes
    const appr = db.raw.prepare(
      "SELECT * FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr' AND status = 'pending'"
    ).all(item.id) as any[];
    expect(appr).toHaveLength(0);
    expect(result.summary).toContain("pull/7");
  });
});

// ── Phase 9 Slice 20: PR caps ─────────────────────────────────────────────────

import { PermanentJobFailureError } from "../src/jobExecutor.js";

describe("createPrLifecycleHandler — PR caps", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => { ({ db, dbPath } = makeDb()); });
  afterEach(() => { db.close(); try { rmSync(dbPath); } catch {} });

  function seedOpenLink(workItemId: number, prNum: number) {
    db.linkGithubPr({
      work_item_id: workItemId, repository: "owner/repo",
      pr_number: prNum, branch_name: `agent/work-other-${prNum}`,
    });
  }

  it("throws PermanentJobFailureError when open PR count reaches maxOpenPrs", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Cap test", created_by: "worker" });
    // seed two open PRs — both remain in default 'draft' state (open)
    const a = db.createWorkItem({ kind: "defect", source: "telegram", title: "A", created_by: "worker" });
    const b = db.createWorkItem({ kind: "defect", source: "telegram", title: "B", created_by: "worker" });
    seedOpenLink(a.id, 10);
    seedOpenLink(b.id, 11);

    await expect(
      createPrLifecycleHandler({ ...makeStubs(), maxOpenPrs: 2 })(
        { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
        { db, workerId: "w" },
      )
    ).rejects.toThrow(PermanentJobFailureError);
  });

  it("reconciles closed or merged GitHub PRs before enforcing open PR cap", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Cap test", created_by: "worker" });
    const a = db.createWorkItem({ kind: "defect", source: "telegram", title: "A", created_by: "worker" });
    const b = db.createWorkItem({ kind: "defect", source: "telegram", title: "B", created_by: "worker" });
    seedOpenLink(a.id, 10);
    seedOpenLink(b.id, 11);

    const stubs = makeStubs();
    stubs.runCommand = vi.fn().mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args[2] === "10") return Promise.resolve(JSON.stringify({ state: "CLOSED" }));
      if (args[0] === "pr" && args[1] === "view" && args[2] === "11") return Promise.resolve(JSON.stringify({ state: "MERGED" }));
      if (args[0] === "pr" && args[1] === "create") return Promise.resolve("https://github.com/owner/repo/pull/12");
      return Promise.resolve("");
    });

    await expect(
      createPrLifecycleHandler({ ...stubs, maxOpenPrs: 1 })(
        { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
        { db, workerId: "w" },
      )
    ).resolves.toBeDefined();

    const states = db.raw.prepare("SELECT pr_number, pr_state FROM github_links WHERE pr_number IN (10, 11)").all() as any[];
    expect(states).toEqual(expect.arrayContaining([
      expect.objectContaining({ pr_number: 10, pr_state: "closed" }),
      expect.objectContaining({ pr_number: 11, pr_state: "merged" }),
    ]));
  });

  it("error message lists the blocking open PRs", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Cap test", created_by: "worker" });
    const a = db.createWorkItem({ kind: "defect", source: "telegram", title: "A", created_by: "worker" });
    seedOpenLink(a.id, 10);

    const err = await createPrLifecycleHandler({ ...makeStubs(), maxOpenPrs: 1 })(
      { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
      { db, workerId: "w" },
    ).catch(e => e);

    expect(err).toBeInstanceOf(PermanentJobFailureError);
    expect(err.message).toMatch(/open PR cap|open.*cap|cap.*open/i);
    expect(err.message).toContain("#10");
  });

  it("update path (existing link for this branch) bypasses open cap", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "worker" });
    const a = db.createWorkItem({ kind: "defect", source: "telegram", title: "A", created_by: "worker" });
    const b = db.createWorkItem({ kind: "defect", source: "telegram", title: "B", created_by: "worker" });
    seedOpenLink(a.id, 10);
    seedOpenLink(b.id, 11);
    // existing link for THIS branch — puts us on the update path
    db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 7, branch_name: `agent/work-${item.id}` });
    const stubs = { ...makeStubs(), maxOpenPrs: 2 };
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return "newsha\n";
      return "";
    });

    await expect(
      createPrLifecycleHandler(stubs)(
        { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
        { db, workerId: "w" },
      )
    ).resolves.toBeDefined();
  });

  it("throws PermanentJobFailureError when daily PR count reaches maxDailyPrs", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Daily cap test", created_by: "worker" });
    // seed two links for today
    const a = db.createWorkItem({ kind: "defect", source: "telegram", title: "A", created_by: "worker" });
    const b = db.createWorkItem({ kind: "defect", source: "telegram", title: "B", created_by: "worker" });
    db.linkGithubPr({ work_item_id: a.id, repository: "owner/repo", pr_number: 20, branch_name: "agent/work-a" });
    db.linkGithubPr({ work_item_id: b.id, repository: "owner/repo", pr_number: 21, branch_name: "agent/work-b" });
    // close them so they don't affect open-cap count but still count for daily
    db.raw.prepare("UPDATE github_links SET pr_state = 'closed' WHERE pr_number IN (20, 21)").run();

    await expect(
      createPrLifecycleHandler({ ...makeStubs(), maxDailyPrs: 2 })(
        { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
        { db, workerId: "w" },
      )
    ).rejects.toThrow(PermanentJobFailureError);
  });

  it("daily count ignores links from previous days", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Old link", created_by: "worker" });
    const old = db.createWorkItem({ kind: "defect", source: "telegram", title: "Old", created_by: "worker" });
    db.linkGithubPr({ work_item_id: old.id, repository: "owner/repo", pr_number: 30, branch_name: "agent/old" });
    // backdate the link
    db.raw.prepare("UPDATE github_links SET created_at = datetime('now', '-1 day') WHERE pr_number = 30").run();

    // maxDailyPrs=1 but the only link is from yesterday — should not block
    await expect(
      createPrLifecycleHandler({ ...makeStubs(), maxDailyPrs: 1 })(
        { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
        { db, workerId: "w" },
      )
    ).resolves.toBeDefined();
  });
});

// ── Phase 9 Slice 25: owner decision brief ────────────────────────────────────

describe("createPrLifecycleHandler — decision brief", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => { ({ db, dbPath } = makeDb()); });
  afterEach(() => { db.close(); try { rmSync(dbPath); } catch {} });

  it("reads commit subjects for the proof comment/decision context without creating a merge approval", async () => {
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return "abc123\n";
      if (args[0] === "log" && args[2] === "origin/main..HEAD") return "fix: green impl\ntest: red test\n";
      if (args[0] === "log") return "feat: unrelated base commit\nfix: green impl\ntest: red test\n";
      return "";
    });
    stubs.runCommand.mockResolvedValue("https://github.com/owner/repo/pull/50");

    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "w" });
    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    const appr = db.raw.prepare(
      "SELECT payload_json FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr'"
    ).all(item.id) as any[];
    expect(appr).toHaveLength(0);
    expect(stubs.runGit).toHaveBeenCalledWith(["log", "--format=%s", "origin/main..HEAD"], undefined);
  });

  it("reads files_summary from the branch diff without creating a merge approval", async () => {
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return "abc123\n";
      if (args[0] === "diff" && args[2] === "origin/main..HEAD") return " src/foo.ts | 10 ++++\n 1 file changed, 10 insertions(+)\n";
      return "";
    });
    stubs.runCommand.mockResolvedValue("https://github.com/owner/repo/pull/51");

    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "w" });
    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    const appr = db.raw.prepare(
      "SELECT payload_json FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr'"
    ).all(item.id) as any[];
    expect(appr).toHaveLength(0);
    expect(stubs.runGit).toHaveBeenCalledWith(["diff", "--stat", "origin/main..HEAD"], undefined);
  });

  it("defers verify_tail approval payload until CI passes", async () => {
    const stubs = makeStubs();
    stubs.runCommand.mockResolvedValue("https://github.com/owner/repo/pull/52");

    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "w" });
    await createPrLifecycleHandler(stubs)(
      {
        work_item_id: item.id, branch_name: `agent/work-${item.id}`,
        repository: "owner/repo", verify_output: "42 passed",
      },
      { db, workerId: "w" },
    );

    const appr = db.raw.prepare(
      "SELECT payload_json FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr'"
    ).all(item.id) as any[];
    expect(appr).toHaveLength(0);
  });

  it("falls back gracefully when git log/diff fail", async () => {
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "push") return "";
      if (args[0] === "rev-parse") return "sha\n";
      throw new Error("git not available");
    });
    stubs.runCommand.mockResolvedValue("https://github.com/owner/repo/pull/53");

    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "w" });
    await expect(
      createPrLifecycleHandler(stubs)(
        { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
        { db, workerId: "w" },
      )
    ).resolves.toBeDefined(); // does not throw
  });
});

// ── Phase 9 Slice 26: PR proof comment ────────────────────────────────────────

describe("createPrLifecycleHandler — proof comment", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => { ({ db, dbPath } = makeDb()); });
  afterEach(() => { db.close(); try { rmSync(dbPath); } catch {} });

  it("posts a proof comment to the PR after opening", async () => {
    const stubs = makeStubs();
    stubs.runCommand
      .mockResolvedValueOnce("https://github.com/owner/repo/pull/60")
      .mockResolvedValue(""); // subsequent calls (comment)

    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "w" });
    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    const commentCall = stubs.runCommand.mock.calls.find(([bin, args]: [string, string[]]) =>
      bin === "gh" && args.includes("comment")
    );
    expect(commentCall).toBeDefined();
  });

  it("includes verify_output in the proof comment body", async () => {
    const stubs = makeStubs();
    stubs.runCommand
      .mockResolvedValueOnce("https://github.com/owner/repo/pull/61")
      .mockResolvedValue("");

    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "w" });
    await createPrLifecycleHandler(stubs)(
      {
        work_item_id: item.id, branch_name: `agent/work-${item.id}`,
        repository: "owner/repo", verify_output: "42 tests passed",
      },
      { db, workerId: "w" },
    );

    const commentCall = stubs.runCommand.mock.calls.find(([bin, args]: [string, string[]]) =>
      bin === "gh" && args.includes("comment")
    );
    expect(commentCall).toBeDefined();
    const bodyIdx = (commentCall![1] as string[]).indexOf("--body");
    const body = (commentCall![1] as string[])[bodyIdx + 1];
    expect(body).toContain("42 tests passed");
  });

  it("skips the proof comment on idempotent retry when head SHA has not changed", async () => {
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return "fixedsha\n";
      return "";
    });
    stubs.runCommand
      .mockResolvedValueOnce("https://github.com/owner/repo/pull/62")
      .mockResolvedValue("");

    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "w" });
    const branch = `agent/work-${item.id}`;

    // First call: new PR, comment posted
    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: branch, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    const firstCommentCalls = stubs.runCommand.mock.calls.filter(([bin, args]: [string, string[]]) =>
      bin === "gh" && args.includes("comment")
    ).length;
    expect(firstCommentCalls).toBe(1);

    // Second call: same branch → existingLink, same head SHA → skip comment
    stubs.runCommand.mockClear();
    stubs.runCommand.mockResolvedValue("");
    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: branch, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    const secondCommentCalls = stubs.runCommand.mock.calls.filter(([bin, args]: [string, string[]]) =>
      bin === "gh" && args.includes("comment")
    ).length;
    expect(secondCommentCalls).toBe(0);
  });

  it("does not create a missing merge_pr approval on idempotent retry before CI passes", async () => {
    const stubs = makeStubs();
    stubs.runGit = vi.fn().mockImplementation((args: string[]) => {
      if (args[0] === "rev-parse") return "fixedsha\n";
      return "";
    });
    stubs.runCommand.mockResolvedValue("https://github.com/owner/repo/pull/62");

    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "w" });
    const branch = `agent/work-${item.id}`;

    // Seed the github link manually (as if created by a previous interrupted run)
    db.linkGithubPr({
      work_item_id: item.id,
      repository: "owner/repo",
      pr_number: 62,
      branch_name: branch,
    });

    // Verify approvals is currently empty
    const initialApprovals = db.raw.prepare(
      "SELECT * FROM approvals WHERE work_item_id = ?"
    ).all(item.id);
    expect(initialApprovals).toHaveLength(0);

    // Act: execute the handler (idempotent path)
    await createPrLifecycleHandler(stubs)(
      { work_item_id: item.id, branch_name: branch, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    // Assert: approval remains deferred to pr_watch.
    const finalApprovals = db.raw.prepare(
      "SELECT * FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr'"
    ).all(item.id) as any[];
    expect(finalApprovals).toHaveLength(0);
  });
});
