import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { EventReceiptRepository } from "../src/repositories/eventReceiptRepository.js";
import { HealthReportStore } from "../src/health/reports.js";
import {
  acceptHealthOpsEvent,
  executeHealthOpsRun,
  healthEventExecutionStartedKey,
  HealthOpsRunLaneUnavailableError,
  HEALTH_RUN_CHAT_KEY,
  HEALTH_RUN_SURFACE,
} from "../src/health/eventIngress.js";
import type { HealthReport } from "../src/health/types.js";

const paths: string[] = [];
const EXPECTED_TOKEN = "test-shared-secret";

function makeDb() {
  const dbPath = join(tmpdir(), `health-event-restart-${Date.now()}-${Math.random()}.sqlite`);
  paths.push(dbPath);
  return openDb(dbPath, { serviceId: "restart-test", runId: "restart-process", lockLeaseMs: 500 });
}

function redReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    pluginName: "content-crawler",
    status: "red",
    checks: [{ name: "queue-depth", status: "red", message: "queue backed up" }],
    summary: "content-crawler queue is backed up",
    timestamp: "2026-08-13T10:00:00.000Z",
    ...overrides,
  };
}

function event(report = redReport()) {
  return {
    eventId: "evt-restart-1",
    idempotencyKey: "health:content-crawler:red:restart-1",
    occurredAt: report.timestamp,
    report,
    token: EXPECTED_TOKEN,
  };
}

function makeMockClient() {
  return {
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function claudeResult(text: string): string {
  return JSON.stringify({ type: "result", subtype: "success", result: text, session_id: null });
}

function makeEngine(db: ReturnType<typeof openDb>, runCliAsync: (...args: any[]) => Promise<{ text: string }>) {
  return new BridgeEngine(
    {
      surfaceIdentity: HEALTH_RUN_SURFACE,
      kind: "health",
      executionKind: "claude",
      botConfig: { command: "claude", modelPreference: ["default-model"] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      asyncEnabled: true,
      pollIntervalMs: 1000,
    },
    db,
    makeMockClient(),
    { runCliAsync },
  );
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    try { rmSync(path); } catch {}
  }
});

describe("health event restart durability", () => {
  it("can execute a durable received receipt after a crash before Run creation", async () => {
    const db = makeDb();
    const originalInsertRun = db.insertRun.bind(db);
    (db as unknown as { insertRun: typeof db.insertRun }).insertRun = (() => {
      throw new Error("simulated crash before Run creation");
    }) as typeof db.insertRun;

    expect(() => acceptHealthOpsEvent(db, event(), { expectedToken: EXPECTED_TOKEN })).toThrow("simulated crash");
    const receipt = db.getEventReceiptByIdempotencyKey(event().idempotencyKey)!;
    expect(receipt.status).toBe("received");
    expect(receipt.run_id).toBeNull();

    (db as unknown as { insertRun: typeof db.insertRun }).insertRun = originalInsertRun;
    const engine = makeEngine(db, vi.fn().mockResolvedValue({ text: claudeResult("recovered") }));
    const outcome = await executeHealthOpsRun(db, receipt.id, engine);

    expect(outcome.status).toBe("done");
    expect(db.getEventReceipt(receipt.id)!.run_id).toBe(outcome.runId);
    expect(db.getRun(outcome.runId).status).toBe("done");
    db.close();
  });

  it("does not mark a lane-busy Run as execution-started, but marks it while provider work is actually active", async () => {
    const db = makeDb();
    const accepted = acceptHealthOpsEvent(db, event(), { expectedToken: EXPECTED_TOKEN });
    const engine = makeEngine(db, vi.fn().mockResolvedValue({ text: claudeResult("ok") }));
    const held = db.acquireLock(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY)!;

    await expect(executeHealthOpsRun(db, accepted.receiptId, engine)).rejects.toBeInstanceOf(HealthOpsRunLaneUnavailableError);
    expect(db.getSetting(healthEventExecutionStartedKey(accepted.receiptId))).toBeNull();
    db.unlock(held);

    let resolveCli!: (value: { text: string }) => void;
    const cliPromise = new Promise<{ text: string }>((resolve) => { resolveCli = resolve; });
    const activeEngine = makeEngine(db, vi.fn().mockReturnValue(cliPromise));
    const execution = executeHealthOpsRun(db, accepted.receiptId, activeEngine);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(db.getSetting(healthEventExecutionStartedKey(accepted.receiptId))).toBe(accepted.runId);
    resolveCli({ text: claudeResult("done") });
    await execution;
    expect(db.getSetting(healthEventExecutionStartedKey(accepted.receiptId))).toBeNull();
    db.close();
  });

  it("enumerates durable received and run-created receipts for startup replay", () => {
    const db = makeDb();
    const first = acceptHealthOpsEvent(db, event(), { expectedToken: EXPECTED_TOKEN });
    const originalInsertRun = db.insertRun.bind(db);
    (db as unknown as { insertRun: typeof db.insertRun }).insertRun = (() => { throw new Error("crash"); }) as typeof db.insertRun;
    const secondEvent = event(redReport({ pluginName: "server", timestamp: "2026-08-13T10:01:00.000Z" }));
    secondEvent.eventId = "evt-restart-2";
    secondEvent.idempotencyKey = "health:server:red:restart-2";
    expect(() => acceptHealthOpsEvent(db, secondEvent, { expectedToken: EXPECTED_TOKEN })).toThrow("crash");
    (db as unknown as { insertRun: typeof db.insertRun }).insertRun = originalInsertRun;

    const receipts = new EventReceiptRepository(db.raw).listByStatuses(["received", "run_created"]);
    expect(receipts.map((receipt) => receipt.id).sort()).toEqual([first.receiptId, db.getEventReceiptByIdempotencyKey(secondEvent.idempotencyKey)!.id].sort());
    db.close();
  });

  it("persists the previous plugin status across store instances for red-transition detection", () => {
    const db = makeDb();
    const firstStore = new HealthReportStore(db.raw);
    firstStore.saveReport(redReport());

    const restartedStore = new HealthReportStore(db.raw);
    expect(restartedStore.getReport("content-crawler")?.status).toBe("red");
    expect(restartedStore.getReport("missing-plugin")).toBeNull();
    db.close();
  });
});
