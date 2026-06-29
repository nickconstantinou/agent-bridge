import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { startJobExecutorLoop } from "../src/jobExecutorLoop.js";

function makeDb() {
  const dbPath = join(tmpdir(), `loop-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

describe("startJobExecutorLoop", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    ({ db, dbPath } = makeDb());
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("returns a stop function", () => {
    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: {},
      sendMessage: vi.fn(),
      intervalMs: 5000,
    });
    expect(typeof stop).toBe("function");
    stop();
  });

  it("returns a stop function that is also a JobExecutorStopFn with isIdle property", () => {
    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: {},
      sendMessage: vi.fn(),
      intervalMs: 5000,
    });
    expect(typeof stop).toBe("function");
    expect(typeof (stop as any).stop).toBe("function");
    expect(typeof (stop as any).isIdle).toBe("function");
    expect((stop as any).isIdle()).toBe(true);
    (stop as any).stop();
  });

  it("calls executeNextJob after the interval fires", async () => {
    const handler = vi.fn().mockResolvedValue({ summary: "done" });

    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:test:1",
      input_json: { repository: "test-repo" },
    });

    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      sendMessage: vi.fn(),
      intervalMs: 1000,
    });

    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("sends a Telegram notification to notify_chat_id after job completes", async () => {
    const handler = vi.fn().mockResolvedValue({ summary: "Found 1 issue." });
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:test:2",
      input_json: { repository: "test-repo", notify_chat_id: 12345 },
    });

    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      sendMessage,
      intervalMs: 1000,
    });

    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(sendMessage).toHaveBeenCalledOnce();
    const [chatId, text] = sendMessage.mock.calls[0];
    expect(chatId).toBe(12345);
    expect(text).toContain("Found 1 issue.");
  });

  it("sends work item HTML approval packs for handler-created work items", async () => {
    const item = db.createWorkItem({
      kind: "refactor",
      source: "refactor_scan",
      repository: "owner/repo",
      title: "Simplify module",
      created_by: "worker",
      body: "Implementation plan",
    });
    const handler = vi.fn().mockResolvedValue({
      summary: "Refactor scan found 1 opportunity.",
      work_item_ids: [item.id],
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sendApprovalPack = vi.fn().mockResolvedValue(undefined);

    db.createWorkJob({
      task_type: "refactor_scan",
      idempotency_key: "refactor:pack:1",
      input_json: { repository: "owner/repo", notify_chat_id: 12345, notify_thread_id: 77 },
    });

    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: { refactor_scan: handler },
      sendMessage,
      sendApprovalPack,
      intervalMs: 1000,
    });

    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(sendApprovalPack).toHaveBeenCalledWith(12345, expect.objectContaining({
      filename: `work-item-${item.id}.html`,
      html: expect.stringContaining("Simplify module"),
    }), 77);
    expect(sendMessage).toHaveBeenCalledWith(12345, expect.stringContaining("Refactor scan"), undefined, 77);
  });

  it("sends PR approval HTML packs when pr_watch reports ready approvals", async () => {
    const item = db.createWorkItem({
      kind: "defect",
      source: "defect_scan",
      repository: "owner/repo",
      title: "Fix issue",
      created_by: "worker",
    });
    db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 9, branch_name: "agent/work-9", commit_sha: "sha" });
    db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_number: 9, pr_url: "https://github.com/owner/repo/pull/9", repository: "owner/repo" },
    });
    const handler = vi.fn().mockResolvedValue({
      summary: "#9 ready to merge",
      pr_approval_work_item_ids: [item.id],
    });
    const sendApprovalPack = vi.fn().mockResolvedValue(undefined);

    db.createWorkJob({
      task_type: "pr_watch",
      idempotency_key: "pr-watch:pack:1",
      input_json: { notify_chat_id: 999, notify_thread_id: 88 },
    });

    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: { pr_watch: handler },
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendApprovalPack,
      intervalMs: 1000,
    });

    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(sendApprovalPack).toHaveBeenCalledWith(999, expect.objectContaining({
      filename: "pr-9.html",
      html: expect.stringContaining("PR Approval Pack"),
    }), 88);
  });

  it("does not call sendMessage when no notify_chat_id is set", async () => {
    const handler = vi.fn().mockResolvedValue({ summary: "All clear." });
    const sendMessage = vi.fn();

    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:test:3",
      input_json: { repository: "test-repo" },
    });

    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      sendMessage,
      intervalMs: 1000,
    });

    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not start a second job while one is still in flight", async () => {
    const resolvers: Array<(v: { summary: string }) => void> = [];
    const handler = vi.fn(
      () => new Promise<{ summary: string }>((res) => resolvers.push(res)),
    );

    db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:serial:1" });
    db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:serial:2" });

    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      sendMessage: vi.fn(),
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000); // tick 1 — claims job 1
    expect(handler).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000); // ticks 2-3 — job 1 still running
    expect(handler).toHaveBeenCalledTimes(1);

    resolvers[0]({ summary: "done" }); // finish job 1
    await vi.advanceTimersByTimeAsync(1000); // next tick — job 2 may start
    expect(handler).toHaveBeenCalledTimes(2);

    resolvers[1]({ summary: "done" });
    await vi.advanceTimersByTimeAsync(0);
    stop();
  });

  it("fails an unhandled task type with a notification instead of re-sending start_message forever", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const job = db.createWorkJob({
      task_type: "ops_check",
      idempotency_key: "ops:unhandled:1",
      input_json: {
        notify_chat_id: 999,
        start_message: "Starting ops check...",
      },
    });

    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: {}, // no handler registered for ops_check
      sendMessage,
      intervalMs: 1000,
    });

    await vi.runOnlyPendingTimersAsync(); // tick 1
    await vi.runOnlyPendingTimersAsync(); // tick 2 — must not repeat anything
    stop();

    expect(db.getWorkJob(job.id)!.status).toBe("failed");
    // Exactly one failure notification; the start_message must not be sent
    const texts = sendMessage.mock.calls.map(c => c[1] as string);
    expect(texts.some(t => t.includes("Starting ops check..."))).toBe(false);
    const failureTexts = texts.filter(t => /no handler/i.test(t));
    expect(failureTexts).toHaveLength(1);
  });

  it("suppresses noisy ANSI/test output in worker failure notifications", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const noisyError = [
      "Verification failed after implementation:",
      "",
      "\u001b[90mstderr\u001b[39m",
      "diff --git a/test/workerBot.test.ts b/test/workerBot.test.ts",
      "@@ -1,3 +1,9 @@",
      "+  it(\"recognises /refactor\", () => expect(isWorkerCommand(\"/refactor\")).toBe(true));",
      "FAIL  test/workerBot.test.ts > worker /refactor command with DB",
      "AssertionError: expected null not to be null",
      "Test Files  2 failed (2)",
      "Tests  9 failed | 154 passed (163)",
    ].join("\n");

    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:noisy-failure:1",
      input_json: { notify_chat_id: 321 },
      max_attempts: 1,
    });

    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: vi.fn(async () => { throw new Error(noisyError); }) },
      sendMessage,
      intervalMs: 1000,
    });

    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(sendMessage).toHaveBeenCalledOnce();
    const text = sendMessage.mock.calls[0][1] as string;
    expect(text).toContain("Job #");
    expect(text).toContain("Verification failed after implementation");
    expect(text).toContain("Output suppressed");
    expect(text).toContain("Test Files  2 failed (2)");
    expect(text).not.toContain("\u001b[90m");
    expect(text).not.toContain("diff --git");
    expect(text).not.toContain("recognises /refactor");
  });

  it("sends start_message before handler runs when set in input_json", async () => {
    const callOrder: string[] = [];
    const handler = vi.fn(async () => {
      callOrder.push("handler");
      return { summary: "Scan complete." };
    });
    const sendMessage = vi.fn(async (_chatId: number, text: string) => {
      callOrder.push(text.includes("Scanning") ? "start" : "complete");
    });

    db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:start-notify:1",
      input_json: {
        repository: "test-repo",
        notify_chat_id: 555,
        start_message: "Scanning repository...",
      },
    });

    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      sendMessage,
      intervalMs: 1000,
    });

    await vi.runOnlyPendingTimersAsync();
    stop();

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(["start", "handler", "complete"]);
    expect(sendMessage.mock.calls[0][1]).toContain("Scanning repository...");
  });

  it("does not send start_message on lease-expired re-claim (status was running)", async () => {
    const handler = vi.fn().mockResolvedValue({ summary: "done" });
    const sendMessage = vi.fn().mockResolvedValue(undefined);

    const job = db.createWorkJob({
      task_type: "defect_scan",
      idempotency_key: "scan:re-claim:1",
      input_json: {
        notify_chat_id: 777,
        start_message: "Scanning...",
      },
    });

    // Simulate a previously-claimed running job with an expired lease
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    db.raw.prepare(
      `UPDATE work_jobs SET status='running', lease_owner='old-worker', lease_expires_at=? WHERE id=?`
    ).run(pastExpiry, job.id);

    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      sendMessage,
      intervalMs: 1000,
    });

    await vi.runOnlyPendingTimersAsync();
    stop();

    // Only the completion notification, not the start_message re-sent
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toContain("done");
  });

  it("stops polling after stop() is called", async () => {
    const handler = vi.fn().mockResolvedValue({ summary: "done" });

    const stop = startJobExecutorLoop({
      db,
      workerId: "test-worker",
      handlers: { defect_scan: handler },
      sendMessage: vi.fn(),
      intervalMs: 1000,
    });

    stop();
    await vi.runAllTimersAsync();

    expect(handler).not.toHaveBeenCalled();
  });
});
