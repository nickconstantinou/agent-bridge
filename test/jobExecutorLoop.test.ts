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
