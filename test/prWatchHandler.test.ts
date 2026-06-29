import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createPrWatchHandler } from "../src/handlers/prWatch.js";

function makeDb() {
  const dbPath = join(tmpdir(), `pr-watch-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

function makeRunCommand(responses: Record<string, string> = {}) {
  return vi.fn().mockImplementation((_binary: string, args: string[]) => {
    if (args[0] === "run" && args[1] === "view") {
      const runId = args[2];
      return Promise.resolve(responses[`run:${runId}`] ?? "failed log output");
    }
    const prNum = args[args.indexOf("view") + 1];
    const key = String(prNum);
    if (key in responses) return Promise.resolve(responses[key]);
    return Promise.resolve(JSON.stringify({
      headRefOid: "abc123",
      statusCheckRollup: [],
      mergeable: "MERGEABLE",
      updatedAt: new Date().toISOString(),
    }));
  });
}

function prViewPayload(opts: {
  headRefOid?: string;
  failing?: boolean;
  passing?: boolean;
  updatedAt?: string;
  detailsUrl?: string;
} = {}) {
  const { headRefOid = "abc123", failing = false, passing = false, updatedAt = new Date().toISOString(), detailsUrl } = opts;
  const rollup = failing
    ? [{ __typename: "CheckRun", conclusion: "FAILURE", name: "ci/test", detailsUrl }]
    : passing
    ? [{ __typename: "CheckRun", conclusion: "SUCCESS", name: "ci/test" }]
    : [];
  return JSON.stringify({ headRefOid, statusCheckRollup: rollup, mergeable: "MERGEABLE", updatedAt });
}

describe("createPrWatchHandler", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => { ({ db, dbPath } = makeDb()); });
  afterEach(() => { db.close(); try { rmSync(dbPath); } catch {} });

  it("returns a handler function", () => {
    expect(typeof createPrWatchHandler({ runCommand: makeRunCommand() })).toBe("function");
  });

  it("returns early when there are no open agent PRs", async () => {
    const runCommand = makeRunCommand();
    const handler = createPrWatchHandler({ runCommand });
    const result = await handler({}, { db, workerId: "w" });
    expect(runCommand).not.toHaveBeenCalled();
    expect(result.summary).toMatch(/no open/i);
  });

  it("skips held PRs without calling gh pr view", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 5, branch_name: "agent/work-5" });
    db.updatePrState(link.id, "held");

    const runCommand = makeRunCommand();
    await createPrWatchHandler({ runCommand })({}, { db, workerId: "w" });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("marks a PR stale when updatedAt exceeds staleHours", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 6, branch_name: "agent/work-6" });

    const staleDate = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString(); // 73h ago
    const runCommand = makeRunCommand({ "6": prViewPayload({ updatedAt: staleDate }) });

    await createPrWatchHandler({ runCommand, staleHours: 72 })({}, { db, workerId: "w" });

    const updated = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(updated.pr_state).toBe("stale");
  });

  it("does not mark a recently updated PR as stale", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 7, branch_name: "agent/work-7" });

    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const runCommand = makeRunCommand({ "7": prViewPayload({ updatedAt: recentDate }) });

    await createPrWatchHandler({ runCommand, staleHours: 72 })({}, { db, workerId: "w" });

    const updated = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(updated.pr_state).not.toBe("stale");
  });

  it("marks PR ci_failed and enqueues a fix job when checks fail", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 8, branch_name: "agent/work-8" });

    const runCommand = makeRunCommand({ "8": prViewPayload({ failing: true, headRefOid: "sha111" }) });
    await createPrWatchHandler({ runCommand })({}, { db, workerId: "w" });

    const updated = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(updated.pr_state).toBe("ci_failed");

    const jobs = db.raw.prepare(
      "SELECT * FROM work_jobs WHERE idempotency_key = ?"
    ).all(`ci_fix:owner/repo:8:sha111`) as any[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].task_type).toBe("tdd_implementation");
  });

  it("passes failed GitHub Actions logs into the CI fix job", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 18, branch_name: "agent/work-18" });

    const detailsUrl = "https://github.com/owner/repo/actions/runs/123456789/job/987654321";
    const runCommand = makeRunCommand({
      "18": prViewPayload({ failing: true, headRefOid: "sha-log", detailsUrl }),
      "run:123456789": "npm test failed\nexpected true to be false",
    });
    await createPrWatchHandler({ runCommand })({}, { db, workerId: "w" });

    expect(runCommand).toHaveBeenCalledWith("gh", [
      "run", "view", "123456789",
      "--repo", "owner/repo",
      "--log-failed",
    ]);
    const job = db.raw.prepare("SELECT * FROM work_jobs WHERE idempotency_key = ?").get("ci_fix:owner/repo:18:sha-log") as any;
    const input = JSON.parse(job.input_json);
    expect(input.ci_failure_log).toContain("expected true to be false");
    expect(input.ci_failure_summary).toContain("ci/test");
  });

  it("marks PR ci_failed_needs_human when the one fix job for the head already failed", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 19, branch_name: "agent/work-19" });
    const key = "ci_fix:owner/repo:19:sha-repeat";
    const job = db.createWorkJob({
      task_type: "tdd_implementation",
      idempotency_key: key,
      work_item_id: item.id,
      input_json: { ci_fix: true },
    });
    db.raw.prepare("UPDATE work_jobs SET status='failed', error='could not fix' WHERE id=?").run(job.id);

    const runCommand = makeRunCommand({ "19": prViewPayload({ failing: true, headRefOid: "sha-repeat" }) });
    const result = await createPrWatchHandler({ runCommand })({}, { db, workerId: "w" });

    const updated = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(updated.pr_state).toBe("ci_failed_needs_human");
    expect(result.summary).toMatch(/needs human/i);
    const jobs = db.raw.prepare("SELECT * FROM work_jobs WHERE idempotency_key = ?").all(key) as any[];
    expect(jobs).toHaveLength(1);
  });

  it("does not enqueue a duplicate fix job for the same head SHA", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 9, branch_name: "agent/work-9" });

    const runCommand = makeRunCommand({ "9": prViewPayload({ failing: true, headRefOid: "sha222" }) });
    const handler = createPrWatchHandler({ runCommand });
    await handler({}, { db, workerId: "w" });
    await handler({}, { db, workerId: "w" });

    const jobs = db.raw.prepare(
      "SELECT * FROM work_jobs WHERE idempotency_key = ?"
    ).all("ci_fix:owner/repo:9:sha222") as any[];
    expect(jobs).toHaveLength(1);
  });

  it("marks PR ready_to_merge and creates a merge approval when CI passes", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 12, branch_name: "agent/work-12" });

    const runCommand = makeRunCommand({ "12": prViewPayload({ passing: true, headRefOid: "greensha" }) });
    await createPrWatchHandler({ runCommand })({}, { db, workerId: "w" });

    const updated = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(updated.pr_state).toBe("ready_to_merge");

    const approvals = db.raw.prepare(
      "SELECT * FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr' AND status = 'pending'"
    ).all(item.id) as any[];
    expect(approvals).toHaveLength(1);
    expect(JSON.parse(approvals[0].payload_json).head_sha).toBe("greensha");
  });

  it("refreshes head_sha in existing pending approval when CI passes", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 13, branch_name: "agent/work-13" });
    db.createApproval({
      approval_type: "merge_pr", requested_by: "agent", work_item_id: item.id,
      payload: { pr_number: 13, head_sha: "oldsha" },
    });

    const runCommand = makeRunCommand({ "13": prViewPayload({ passing: true, headRefOid: "newsha" }) });
    await createPrWatchHandler({ runCommand })({}, { db, workerId: "w" });

    const approvals = db.raw.prepare(
      "SELECT * FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr' AND status = 'pending'"
    ).all(item.id) as any[];
    expect(approvals).toHaveLength(1);
    expect(JSON.parse(approvals[0].payload_json).head_sha).toBe("newsha");
  });

  it("does not create duplicate approvals when PR is already ready_to_merge", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 14, branch_name: "agent/work-14" });
    db.updatePrState(link.id, "ready_to_merge");
    db.createApproval({
      approval_type: "merge_pr", requested_by: "agent", work_item_id: item.id,
      payload: { pr_number: 14, head_sha: "sha" },
    });

    const runCommand = makeRunCommand({ "14": prViewPayload({ passing: true, headRefOid: "sha" }) });
    const handler = createPrWatchHandler({ runCommand });
    await handler({}, { db, workerId: "w" });
    await handler({}, { db, workerId: "w" });

    const approvals = db.raw.prepare(
      "SELECT * FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr' AND status = 'pending'"
    ).all(item.id) as any[];
    expect(approvals).toHaveLength(1);
  });
});

// ── Phase 9 Slice 22: stale digest ────────────────────────────────────────────

import type { GithubLink } from "../src/db.js";

describe("createPrWatchHandler — stale digest", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => { ({ db, dbPath } = makeDb()); });
  afterEach(() => { db.close(); try { rmSync(dbPath); } catch {} });

  it("calls notifyStale once with all newly-stale PRs", async () => {
    const notifyStale = vi.fn().mockResolvedValue(undefined);

    // Two PRs that are both past the stale threshold
    const staleDate = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
    const item1 = db.createWorkItem({ kind: "defect", source: "telegram", title: "A", created_by: "w" });
    const item2 = db.createWorkItem({ kind: "defect", source: "telegram", title: "B", created_by: "w" });
    db.linkGithubPr({ work_item_id: item1.id, repository: "owner/repo", pr_number: 20, branch_name: "agent/a" });
    db.linkGithubPr({ work_item_id: item2.id, repository: "owner/repo", pr_number: 21, branch_name: "agent/b" });

    const runCommand = vi.fn().mockResolvedValue(
      JSON.stringify({ headRefOid: "s", statusCheckRollup: [], mergeable: "MERGEABLE", updatedAt: staleDate })
    );
    await createPrWatchHandler({ runCommand, staleHours: 72, notifyStale })({}, { db, workerId: "w" });

    expect(notifyStale).toHaveBeenCalledOnce();
    const [stalePrs]: [GithubLink[]] = notifyStale.mock.calls[0];
    expect(stalePrs.map((p: GithubLink) => p.pr_number).sort()).toEqual([20, 21]);
  });

  it("does not call notifyStale when no PRs are newly stale", async () => {
    const notifyStale = vi.fn().mockResolvedValue(undefined);
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 22, branch_name: "agent/c" });

    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const runCommand = vi.fn().mockResolvedValue(prViewPayload({ updatedAt: recentDate }));
    await createPrWatchHandler({ runCommand, staleHours: 72, notifyStale })({}, { db, workerId: "w" });

    expect(notifyStale).not.toHaveBeenCalled();
  });

  it("queues a pre-merge defect scan and marks review_pending when enabled", async () => {
    process.env.PR_DEFECT_SCAN_ENABLED = "true";
    try {
      const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
      const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 30, branch_name: "agent/work-30" });

      const runCommand = makeRunCommand({ "30": prViewPayload({ passing: true, headRefOid: "greensha" }) });
      await createPrWatchHandler({ runCommand })({}, { db, workerId: "w" });

      const updated = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
      expect(updated.pr_state).toBe("review_pending");

      const jobs = db.raw.prepare("SELECT * FROM work_jobs WHERE task_type = 'defect_scan'").all() as any[];
      expect(jobs).toHaveLength(1);
      expect(jobs[0].idempotency_key).toBe("ci_defect_scan:owner/repo:30:greensha");
      expect(JSON.parse(jobs[0].input_json).pr_mode).toBe(true);
    } finally {
      delete process.env.PR_DEFECT_SCAN_ENABLED;
    }
  });

  it("advances to ready_to_merge once pre-merge defect scan completes successfully", async () => {
    process.env.PR_DEFECT_SCAN_ENABLED = "true";
    try {
      const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
      const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 31, branch_name: "agent/work-31" });

      // First run: queues scan job
      const runCommand = makeRunCommand({ "31": prViewPayload({ passing: true, headRefOid: "greensha" }) });
      await createPrWatchHandler({ runCommand })({}, { db, workerId: "w" });

      // Mark the scan job as completed
      db.raw.prepare("UPDATE work_jobs SET status = 'completed' WHERE task_type = 'defect_scan'").run();

      // Second run: progresses to ready_to_merge and creates approval
      await createPrWatchHandler({ runCommand })({}, { db, workerId: "w" });

      const updated = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
      expect(updated.pr_state).toBe("ready_to_merge");

      const approvals = db.raw.prepare("SELECT * FROM approvals WHERE work_item_id = ?").all(item.id) as any[];
      expect(approvals).toHaveLength(1);
    } finally {
      delete process.env.PR_DEFECT_SCAN_ENABLED;
    }
  });
});
