/**
 * Tests for the PR merge gate — inline keyboard notification after pr_lifecycle
 * completes, and the wi_mrgpr / wi_clspr callback handlers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { buildPrMergeKeyboard, parsePrMergeCallback } from "../src/prMergeGate.js";

function makeDb() {
  const dbPath = join(tmpdir(), `pr-merge-gate-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

describe("parsePrMergeCallback", () => {
  it("parses wi:<id>:mrgpr", () => {
    const result = parsePrMergeCallback("wi:42:mrgpr");
    expect(result).toEqual({ type: "wi_mrgpr", id: 42 });
  });

  it("parses wi:<id>:clspr", () => {
    const result = parsePrMergeCallback("wi:7:clspr");
    expect(result).toEqual({ type: "wi_clspr", id: 7 });
  });

  it("returns null for unknown action", () => {
    expect(parsePrMergeCallback("wi:1:appv")).toBeNull();
    expect(parsePrMergeCallback("garbage")).toBeNull();
  });

  it("returns null for non-integer id", () => {
    expect(parsePrMergeCallback("wi:abc:mrgpr")).toBeNull();
  });
});

describe("buildPrMergeKeyboard", () => {
  it("returns an inline_keyboard with Merge and Close buttons", () => {
    const keyboard = buildPrMergeKeyboard(5);
    expect(keyboard.inline_keyboard).toHaveLength(1);
    const row = keyboard.inline_keyboard[0];
    expect(row).toHaveLength(2);
    const merge = row.find((b: any) => b.callback_data === "wi:5:mrgpr");
    const close = row.find((b: any) => b.callback_data === "wi:5:clspr");
    expect(merge).toBeDefined();
    expect(close).toBeDefined();
  });

  it("callback_data for each button is within 64 bytes", () => {
    const keyboard = buildPrMergeKeyboard(999999);
    for (const row of keyboard.inline_keyboard) {
      for (const btn of row) {
        expect(btn.callback_data.length).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("handlePrMergeCallback — wi_mrgpr", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb());
  });
  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  /** runCommand stub that answers `gh pr view` with JSON and `gh pr merge` with text. */
  function makeGhStub(view: object, mergeOutput = "Pull request #3 was merged") {
    return vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("view")) return JSON.stringify(view);
      return mergeOutput;
    });
  }

  function makeApprovedItem(payloadExtra: object = {}) {
    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });
    const link = db.linkGithubPr({
      work_item_id: item.id,
      repository: "owner/repo",
      pr_number: 3,
      branch_name: "agent/work-1",
      commit_sha: "abc123"
    });
    db.updatePrState(link.id, "ready_to_merge");
    const approval = db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: {
        pr_url: "https://github.com/owner/repo/pull/3", pr_number: 3,
        branch_name: "agent/work-1", repository: "owner/repo",
        ...payloadExtra,
      },
    });
    return { item, approval, link };
  }

  it("blocks merge when local PR state has not been marked ready_to_merge by pr_watch", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");
    const { item, approval, link } = makeApprovedItem({ head_sha: "abc123" });
    db.updatePrState(link.id, "ci_pending");

    const runCommand = makeGhStub({
      headRefOid: "abc123",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    });
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const cleanupWorkspace = vi.fn();

    await handlePrMergeCallback(
      { type: "wi_mrgpr", id: item.id },
      { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1", cleanupWorkspace }
    );

    const mergeCall = runCommand.mock.calls.find(([, args]) => args.includes("merge"));
    expect(mergeCall).toBeUndefined();
    expect(editMessage).toHaveBeenCalledWith(expect.stringMatching(/pr_watch|ready_to_merge|CI watch/i), expect.anything());
    const row = db.raw.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id) as any;
    expect(row.status).toBe("pending");
  });

  it("resolves stale approval when GitHub says the PR is already merged even if local state is stale", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");
    const { item, approval, link } = makeApprovedItem({ head_sha: "abc123" });
    db.updatePrState(link.id, "ci_pending");

    const runCommand = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("view")) return JSON.stringify({ state: "MERGED" });
      return "";
    });
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const cleanupWorkspace = vi.fn();

    await handlePrMergeCallback(
      { type: "wi_mrgpr", id: item.id },
      { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1", cleanupWorkspace }
    );

    const row = db.raw.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id) as any;
    expect(row.status).toBe("approved");
    expect(db.getWorkItem(item.id)!.status).toBe("resolved");
    const updatedLink = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(updatedLink.pr_state).toBe("merged");
    expect(editMessage).toHaveBeenCalledWith(expect.stringMatching(/already merged/i));
  });

  it("resolves the merge_pr approval and merges when head SHA matches and checks pass", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");
    const { item, approval, link } = makeApprovedItem({ head_sha: "abc123" });
    db.updatePrState(link.id, "ready_to_merge");

    const runCommand = makeGhStub({
      headRefOid: "abc123",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    });
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const cleanupWorkspace = vi.fn();

    await handlePrMergeCallback(
      { type: "wi_mrgpr", id: item.id },
      { db, runCommand, answerCbq, editMessage, cleanupWorkspace, chatId: 100, messageId: 200, userId: "u1" }
    );

    const mergeCall = runCommand.mock.calls.find(([, args]) => args.includes("merge"));
    expect(mergeCall).toBeDefined();
    expect(mergeCall![1]).toContain("--squash");

    const resolved = db.raw.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id) as any;
    expect(resolved.status).toBe("approved");
    expect(db.getWorkItem(item.id)!.status).toBe("resolved");
    const mergedLink = db.raw.prepare("SELECT pr_state FROM github_links WHERE work_item_id = ? AND pr_number = 3").get(item.id) as any;
    expect(mergedLink.pr_state).toBe("merged");
    expect(cleanupWorkspace).toHaveBeenCalledWith(expect.stringContaining(`work-${item.id}`));
  });

  it("marks draft PRs as ready before merging", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");
    const { item, approval, link } = makeApprovedItem({ head_sha: "abc123" });
    db.updatePrState(link.id, "ready_to_merge");

    const runCommand = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("view")) {
        return JSON.stringify({
          headRefOid: "abc123",
          isDraft: true,
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        });
      }
      return "success";
    });
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await handlePrMergeCallback(
      { type: "wi_mrgpr", id: item.id },
      { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1" }
    );

    const readyCall = runCommand.mock.calls.find(([, args]) => args.includes("ready"));
    expect(readyCall).toBeDefined();
    expect(readyCall![1]).toContain("ready");

    const mergeCall = runCommand.mock.calls.find(([, args]) => args.includes("merge"));
    expect(mergeCall).toBeDefined();

    const resolved = db.raw.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id) as any;
    expect(resolved.status).toBe("approved");
  });

  it("blocks merge when the PR head SHA does not match the approval payload", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");
    const { item, approval } = makeApprovedItem({ head_sha: "abc123" });

    const runCommand = makeGhStub({
      headRefOid: "ffff9999", // head moved since approval was requested
      statusCheckRollup: [],
    });
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await handlePrMergeCallback(
      { type: "wi_mrgpr", id: item.id },
      { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1" }
    );

    const mergeCall = runCommand.mock.calls.find(([, args]) => args.includes("merge"));
    expect(mergeCall).toBeUndefined();
    expect(answerCbq).toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith(expect.stringMatching(/head|changed/i), expect.anything());
    // Approval stays pending so the user can re-review and retry
    const row = db.raw.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id) as any;
    expect(row.status).toBe("pending");
    expect(db.getWorkItem(item.id)!.status).not.toBe("resolved");
  });

  it("blocks merge when CI checks are failing or incomplete", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");

    for (const rollup of [
      [{ status: "COMPLETED", conclusion: "FAILURE" }],
      [{ status: "IN_PROGRESS", conclusion: null }],
      [{ state: "FAILURE" }],
    ]) {
      const { item, link } = makeApprovedItem({ head_sha: "abc123" });
      const runCommand = makeGhStub({ headRefOid: "abc123", statusCheckRollup: rollup });
      const answerCbq = vi.fn().mockResolvedValue(undefined);
      const editMessage = vi.fn().mockResolvedValue(undefined);

      await handlePrMergeCallback(
        { type: "wi_mrgpr", id: item.id },
        { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1" }
      );

      const mergeCall = runCommand.mock.calls.find(([, args]) => args.includes("merge"));
      expect(mergeCall).toBeUndefined();
      expect(editMessage).toHaveBeenCalledWith(expect.stringMatching(/check/i), expect.anything());

      // Verify that pr_state was updated and tdd_implementation job was enqueued
      const updatedLink = db.raw.prepare("SELECT * FROM github_links WHERE id = ?").get(link.id) as any;
      expect(updatedLink.pr_state).toBe("ci_failed");

      const jobs = db.listWorkJobs({ status: "pending" });
      const fixJob = jobs.find(j => j.task_type === "tdd_implementation");
      expect(fixJob).toBeDefined();
      expect(JSON.parse(fixJob!.input_json)).toEqual({
        work_item_id: item.id,
        repository: "owner/repo",
        branch_name: "agent/work-1",
        ci_fix: true,
      });

      // Clear database state for next loop iteration
      db.raw.exec("DELETE FROM work_jobs");
      db.raw.exec("DELETE FROM github_links");
      db.raw.exec("DELETE FROM approvals");
      db.raw.exec("DELETE FROM work_items");
    }
  });

  it("reports merge command failure via the message instead of throwing", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");
    const { item, approval, link } = makeApprovedItem({ head_sha: "abc123" });

    const runCommand = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("view")) {
        return JSON.stringify({ headRefOid: "abc123", statusCheckRollup: [] });
      }
      throw new Error("GraphQL: Pull Request is still a draft");
    });
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await expect(
      handlePrMergeCallback(
        { type: "wi_mrgpr", id: item.id },
        { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1" }
      )
    ).resolves.toBeUndefined();

    expect(answerCbq).toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith(expect.stringMatching(/failed|draft/i), expect.anything());
    // Approval must remain pending after a failed merge
    const row = db.raw.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id) as any;
    expect(row.status).toBe("pending");

    // Verify that pr_state was updated and tdd_implementation job was enqueued
    const updatedLink = db.raw.prepare("SELECT * FROM github_links WHERE id = ?").get(link.id) as any;
    expect(updatedLink.pr_state).toBe("ci_failed");

    const jobs = db.listWorkJobs({ status: "pending" });
    const fixJob = jobs.find(j => j.task_type === "tdd_implementation");
    expect(fixJob).toBeDefined();
    expect(JSON.parse(fixJob!.input_json)).toEqual({
      work_item_id: item.id,
      repository: "owner/repo",
      branch_name: "agent/work-1",
      ci_fix: true,
    });
  });

  it("resolves the approval even when branch deletion fails after merge", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");
    const { item, approval } = makeApprovedItem({ head_sha: "abc123" });

    const runCommand = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("view")) {
        return JSON.stringify({ headRefOid: "abc123", statusCheckRollup: [] });
      }
      if (args.includes("merge")) return "Pull request #3 was merged";
      // branch deletion via gh api fails
      throw new Error("422 Reference does not exist");
    });
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await handlePrMergeCallback(
      { type: "wi_mrgpr", id: item.id },
      { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1" }
    );

    // Approval must be resolved even though branch deletion failed
    const resolved = db.raw.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id) as any;
    expect(resolved.status).toBe("approved");
    expect(db.getWorkItem(item.id)!.status).toBe("resolved");
    expect(editMessage).toHaveBeenCalledWith(expect.stringMatching(/merged/i));
  });

  it("treats already-merged error as idempotent success", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");
    const { item, approval } = makeApprovedItem({ head_sha: "abc123" });

    const runCommand = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("view")) {
        return JSON.stringify({ headRefOid: "abc123", statusCheckRollup: [] });
      }
      if (args.includes("merge")) throw new Error("Pull request #3 is already merged");
      return ""; // branch deletion or other ops succeed
    });
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await handlePrMergeCallback(
      { type: "wi_mrgpr", id: item.id },
      { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1" }
    );

    const resolved = db.raw.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id) as any;
    expect(resolved.status).toBe("approved");
    expect(db.getWorkItem(item.id)!.status).toBe("resolved");
  });

  it("answers the callback instead of throwing when no pending approval exists", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
    });

    const answerCbq = vi.fn().mockResolvedValue(undefined);
    await expect(
      handlePrMergeCallback(
        { type: "wi_mrgpr", id: item.id },
        {
          db, runCommand: vi.fn(), answerCbq,
          editMessage: vi.fn(), chatId: 1, messageId: 1, userId: "u"
        }
      )
    ).resolves.toBeUndefined();

    expect(answerCbq).toHaveBeenCalledWith(expect.stringMatching(/no pending|already/i));
  });
});

describe("handlePrMergeCallback — wi_clspr", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb());
  });
  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("closes the PR via gh pr close and transitions work item to closed", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });
    db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_url: "https://github.com/owner/repo/pull/5", pr_number: 5, branch_name: "agent/work-1", repository: "owner/repo" },
    });

    const runCommand = vi.fn().mockResolvedValue("");
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const cleanupWorkspace = vi.fn();

    await handlePrMergeCallback(
      { type: "wi_clspr", id: item.id },
      { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1", cleanupWorkspace }
    );

    const closeCall = runCommand.mock.calls.find(([, args]) => args.includes("close"));
    expect(closeCall).toBeDefined();
    expect(closeCall![0]).toBe("gh");
    expect(closeCall![1]).toContain("close");
    expect(db.getWorkItem(item.id)!.status).toBe("closed");
    expect(cleanupWorkspace).toHaveBeenCalledWith(expect.stringContaining(`work-${item.id}`));
  });

  it("answers the callback with an error message when gh pr close fails with a non-idempotent error", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });
    const approval = db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_url: "https://github.com/owner/repo/pull/5", pr_number: 5, branch_name: "agent/work-1", repository: "owner/repo" },
    });

    const runCommand = vi.fn().mockRejectedValue(new Error("HTTP 502: Bad gateway"));
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await expect(
      handlePrMergeCallback(
        { type: "wi_clspr", id: item.id },
        { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1" }
      )
    ).resolves.toBeUndefined();

    expect(answerCbq).toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith(expect.stringMatching(/failed|close|502/i));
    // Approval must remain pending — close did not succeed
    const row = db.raw.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id) as any;
    expect(row.status).toBe("pending");
    expect(db.getWorkItem(item.id)!.status).not.toBe("closed");
  });

  it("treats already-closed error as idempotent success — resolves approval and closes work item", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });
    const approval = db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_url: "https://github.com/owner/repo/pull/5", pr_number: 5, branch_name: "agent/work-1", repository: "owner/repo" },
    });

    const runCommand = vi.fn().mockRejectedValue(new Error("Pull request #5 is already closed"));
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await handlePrMergeCallback(
      { type: "wi_clspr", id: item.id },
      { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1" }
    );

    const row = db.raw.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id) as any;
    expect(row.status).toBe("rejected");
    expect(db.getWorkItem(item.id)!.status).toBe("closed");
  });

  it("resolves stale close approval when GitHub says the PR is already closed", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");
    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });
    const link = db.linkGithubPr({
      work_item_id: item.id,
      repository: "owner/repo",
      pr_number: 6,
      branch_name: "agent/work-6",
    });
    db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_url: "https://github.com/owner/repo/pull/6", pr_number: 6, repository: "owner/repo" },
    });

    const runCommand = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("view")) return JSON.stringify({ state: "CLOSED" });
      return "";
    });
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await handlePrMergeCallback(
      { type: "wi_clspr", id: item.id },
      { db, runCommand, answerCbq, editMessage, chatId: 1, messageId: 2, userId: "u" },
    );

    const row = db.raw.prepare("SELECT * FROM approvals WHERE work_item_id = ?").get(item.id) as any;
    expect(row.status).toBe("rejected");
    expect(db.getWorkItem(item.id)!.status).toBe("closed");
    const updatedLink = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(updatedLink.pr_state).toBe("closed");
    expect(editMessage).toHaveBeenCalledWith(expect.stringMatching(/already closed/i));
  });

  it("updates github_links pr_state to 'closed' when PR close succeeds", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });
    const link = db.linkGithubPr({
      work_item_id: item.id,
      repository: "owner/repo",
      pr_number: 5,
      branch_name: "agent/work-1",
      commit_sha: "abc123",
    });
    db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_url: "https://github.com/owner/repo/pull/5", pr_number: 5, branch_name: "agent/work-1", repository: "owner/repo" },
    });

    const runCommand = vi.fn().mockResolvedValue("");
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await handlePrMergeCallback(
      { type: "wi_clspr", id: item.id },
      { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1" }
    );

    const updatedLink = db.raw.prepare("SELECT * FROM github_links WHERE id = ?").get(link.id) as any;
    expect(updatedLink.pr_state).toBe("closed");
  });

  it("answers the callback when gh pr close fails with an auth error — does not throw", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });
    db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_url: "https://github.com/owner/repo/pull/9", pr_number: 9, branch_name: "agent/work-2", repository: "owner/repo" },
    });

    const runCommand = vi.fn().mockRejectedValue(new Error("HTTP 401: Bad credentials"));
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await expect(
      handlePrMergeCallback(
        { type: "wi_clspr", id: item.id },
        { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1" }
      )
    ).resolves.toBeUndefined();

    // Telegram callback query must be answered regardless of outcome
    expect(answerCbq).toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith(expect.stringMatching(/failed|close|401|credentials/i));
  });
});
