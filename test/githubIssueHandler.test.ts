import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createGithubIssueHandler } from "../src/handlers/githubIssue.js";

function makeDb() {
  const dbPath = join(tmpdir(), `gh-issue-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

describe("createGithubIssueHandler", () => {
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
    const handler = createGithubIssueHandler({ runCommand: vi.fn() });
    expect(typeof handler).toBe("function");
  });

  it("calls runCommand with gh binary and issue create args", async () => {
    const runCommand = vi.fn().mockResolvedValue("https://github.com/owner/repo/issues/42");
    const handler = createGithubIssueHandler({ runCommand });

    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Fix race condition in lock.ts",
      body: "A race condition was found.",
      created_by: "worker",
    });

    await handler(
      { work_item_id: item.id, repository: "owner/repo" },
      { db, workerId: "test-worker" },
    );

    const createCall = runCommand.mock.calls.find(([, args]) =>
      args[0] === "issue" && args[1] === "create"
    );
    expect(createCall).toBeDefined();
    const [binary, args]: [string, string[]] = createCall!;
    expect(binary).toBe("gh");
    expect(args).toContain("issue");
    expect(args).toContain("create");
    expect(args).toContain("owner/repo");
    expect(args).toContain("Fix race condition in lock.ts");
  });

  it("includes agent-proposed label in the args", async () => {
    const runCommand = vi.fn().mockResolvedValue("https://github.com/owner/repo/issues/1");
    const handler = createGithubIssueHandler({ runCommand });

    const item = db.createWorkItem({
      kind: "feature", source: "telegram",
      title: "Add dark mode", created_by: "worker",
    });

    await handler({ work_item_id: item.id, repository: "owner/repo" }, { db, workerId: "w" });

    const args: string[] = runCommand.mock.calls[0][1];
    expect(args.some(a => a.includes("agent-proposed"))).toBe(true);
  });

  it("stores a github_link record after successful creation", async () => {
    const runCommand = vi.fn().mockResolvedValue("https://github.com/owner/repo/issues/99");
    const handler = createGithubIssueHandler({ runCommand });

    const item = db.createWorkItem({
      kind: "defect", source: "defect_scan",
      title: "Missing error handler", created_by: "worker",
    });

    await handler({ work_item_id: item.id, repository: "owner/repo" }, { db, workerId: "w" });

    const links = db.raw.prepare("SELECT * FROM github_links WHERE work_item_id = ?").all(item.id) as any[];
    expect(links).toHaveLength(1);
    expect(links[0].issue_number).toBe(99);
    expect(links[0].repository).toBe("owner/repo");
  });

  it("posts a Markdown approval pack comment to the created GitHub issue", async () => {
    const runCommand = vi.fn()
      .mockResolvedValueOnce("https://github.com/owner/repo/issues/77")
      .mockResolvedValueOnce("");
    const handler = createGithubIssueHandler({ runCommand });

    const item = db.createWorkItem({
      kind: "feature", source: "telegram",
      title: "Add review pack", body: "Implementation plan text",
      created_by: "worker",
    });

    await handler({ work_item_id: item.id, repository: "owner/repo" }, { db, workerId: "w" });

    const commentCall = runCommand.mock.calls.find(([, args]) =>
      args[0] === "issue" && args[1] === "comment"
    );
    expect(commentCall).toBeDefined();
    expect(commentCall![1]).toEqual(expect.arrayContaining(["issue", "comment", "77", "--repo", "owner/repo", "--body"]));
    const body = commentCall![1][commentCall![1].indexOf("--body") + 1];
    expect(body).toContain("agent-bridge:approval-pack:v1");
    expect(body).toContain("Add review pack");
    expect(body).toContain("Implementation Plan");
    expect(body).toContain("Implementation plan text");
    expect(body).not.toContain("<!doctype html>");
  });

  it("transitions the work_item status to 'in_progress' after issue creation", async () => {
    const runCommand = vi.fn().mockResolvedValue("https://github.com/owner/repo/issues/7");
    const handler = createGithubIssueHandler({ runCommand });

    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Timeout bug", created_by: "worker",
    });

    await handler({ work_item_id: item.id, repository: "owner/repo" }, { db, workerId: "w" });

    const updated = db.getWorkItem(item.id)!;
    expect(updated.status).toBe("in_progress");
  });

  it("returns a summary containing the issue URL", async () => {
    const url = "https://github.com/owner/repo/issues/55";
    const runCommand = vi.fn().mockResolvedValue(url);
    const handler = createGithubIssueHandler({ runCommand });

    const item = db.createWorkItem({
      kind: "feature", source: "telegram",
      title: "New export feature", created_by: "worker",
    });

    const result = await handler(
      { work_item_id: item.id, repository: "owner/repo" },
      { db, workerId: "w" },
    );

    expect(result.summary).toContain(url);
  });

  it("throws if the work_item_id does not exist", async () => {
    const handler = createGithubIssueHandler({ runCommand: vi.fn() });

    await expect(
      handler({ work_item_id: 9999, repository: "owner/repo" }, { db, workerId: "w" })
    ).rejects.toThrow(/not found|missing/i);
  });

  it("throws if runCommand returns no URL", async () => {
    const runCommand = vi.fn().mockResolvedValue("");
    const handler = createGithubIssueHandler({ runCommand });

    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Some bug", created_by: "worker",
    });

    await expect(
      handler({ work_item_id: item.id, repository: "owner/repo" }, { db, workerId: "w" })
    ).rejects.toThrow(/url|issue/i);
  });

  it("propagates command errors", async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error("gh: not logged in"));
    const handler = createGithubIssueHandler({ runCommand });

    const item = db.createWorkItem({
      kind: "defect", source: "telegram",
      title: "Bug", created_by: "worker",
    });

    await expect(
      handler({ work_item_id: item.id, repository: "owner/repo" }, { db, workerId: "w" })
    ).rejects.toThrow("gh: not logged in");
  });
});
