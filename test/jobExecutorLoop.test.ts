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
