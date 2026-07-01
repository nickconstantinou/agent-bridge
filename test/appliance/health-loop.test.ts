import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AppState } from "../../src/appliance/state.js";

// Mock the health module before importing health-loop
vi.mock("../../src/appliance/health.js", () => ({
  checkHealth: vi.fn(),
  recordHealthIncident: vi.fn(),
}));

import { checkHealth, recordHealthIncident } from "../../src/appliance/health.js";
import { startHealthLoop, type HealthLoopHandle } from "../../src/appliance/health-loop.js";

const mockCheckHealth = vi.mocked(checkHealth);
const mockRecordHealthIncident = vi.mocked(recordHealthIncident);

function makeApp(overrides: Partial<AppState> = {}): AppState {
  return {
    name: "test-app",
    repo: "r",
    branch: "main",
    port: 3000,
    domain: "localhost",
    runtime: "node",
    current_commit: "abc123",
    previous_commit: null,
    service_name: "ab-test-app",
    last_deploy_status: "deployed",
    last_health_status: null,
    last_deployed_at: null,
    last_error: null,
    ...overrides,
  };
}

function makeMockDb(apps: AppState[] = []) {
  return {
    listApps: vi.fn().mockReturnValue(apps),
    insertIncident: vi.fn().mockReturnValue(1),
    // include other methods as stubs to satisfy type
    upsertApp: vi.fn(),
    getApp: vi.fn(),
    deleteApp: vi.fn(),
    allocatePort: vi.fn(),
    resolveIncident: vi.fn(),
    getOpenIncidents: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  } as any;
}

let handle: HealthLoopHandle | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  mockCheckHealth.mockReset();
  mockRecordHealthIncident.mockReset();
  mockCheckHealth.mockResolvedValue({ ok: true, status: 200, latencyMs: 5, error: null });
  mockRecordHealthIncident.mockResolvedValue(1);
  handle = null;
});

afterEach(() => {
  if (handle) handle.stop();
  vi.useRealTimers();
});

describe("startHealthLoop", () => {
  it("starts and can be stopped without error", () => {
    const db = makeMockDb([]);
    handle = startHealthLoop(db);
    expect(() => handle!.stop()).not.toThrow();
  });

  it("checks health of deployed apps on tick", async () => {
    const app = makeApp({ last_deploy_status: "deployed", port: 3000 });
    const db = makeMockDb([app]);

    handle = startHealthLoop(db);

    // Advance fake timer by one interval
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockCheckHealth).toHaveBeenCalledOnce();
    expect(mockCheckHealth).toHaveBeenCalledWith(
      "http://localhost:3000/health",
      5_000
    );
  });

  it("also checks rollback-success and restarted apps", async () => {
    const apps = [
      makeApp({ name: "app1", last_deploy_status: "rollback-success", port: 3001 }),
      makeApp({ name: "app2", last_deploy_status: "restarted", port: 3002 }),
    ];
    const db = makeMockDb(apps);

    handle = startHealthLoop(db);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockCheckHealth).toHaveBeenCalledTimes(2);
    expect(mockCheckHealth).toHaveBeenCalledWith("http://localhost:3001/health", 5_000);
    expect(mockCheckHealth).toHaveBeenCalledWith("http://localhost:3002/health", 5_000);
  });

  it("skips apps not in running states", async () => {
    const app = makeApp({ last_deploy_status: "failed" });
    const db = makeMockDb([app]);

    handle = startHealthLoop(db);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockCheckHealth).not.toHaveBeenCalled();
  });

  it("skips apps with null last_deploy_status", async () => {
    const app = makeApp({ last_deploy_status: null });
    const db = makeMockDb([app]);

    handle = startHealthLoop(db);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockCheckHealth).not.toHaveBeenCalled();
  });

  it("records incident when health fails", async () => {
    const failResult = { ok: false, status: null, latencyMs: 100, error: "timeout" };
    mockCheckHealth.mockResolvedValue(failResult);

    const app = makeApp({ last_deploy_status: "deployed", port: 3000 });
    const db = makeMockDb([app]);

    handle = startHealthLoop(db);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockRecordHealthIncident).toHaveBeenCalledOnce();
    expect(mockRecordHealthIncident).toHaveBeenCalledWith(
      db,
      "test-app",
      "http://localhost:3000/health",
      failResult,
      "health-loop"
    );
  });

  it("does not record incident when health succeeds", async () => {
    mockCheckHealth.mockResolvedValue({ ok: true, status: 200, latencyMs: 5, error: null });

    const app = makeApp({ last_deploy_status: "deployed" });
    const db = makeMockDb([app]);

    handle = startHealthLoop(db);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockRecordHealthIncident).not.toHaveBeenCalled();
  });

  it("uses custom intervalMs and timeoutMs", async () => {
    const app = makeApp({ last_deploy_status: "deployed", port: 3000 });
    const db = makeMockDb([app]);

    handle = startHealthLoop(db, { intervalMs: 30_000, timeoutMs: 2_000 });

    // Should not fire before 30s
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mockCheckHealth).not.toHaveBeenCalled();

    // Should fire at 30s
    await vi.advanceTimersByTimeAsync(1);
    expect(mockCheckHealth).toHaveBeenCalledOnce();
    expect(mockCheckHealth).toHaveBeenCalledWith("http://localhost:3000/health", 2_000);
  });

  it("does not crash when individual app check throws", async () => {
    mockCheckHealth.mockRejectedValue(new Error("unexpected network error"));

    const app = makeApp({ last_deploy_status: "deployed" });
    const db = makeMockDb([app]);

    handle = startHealthLoop(db);

    // Should not throw
    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
  });

  it("repeats on subsequent ticks", async () => {
    const app = makeApp({ last_deploy_status: "deployed", port: 3000 });
    const db = makeMockDb([app]);

    handle = startHealthLoop(db);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockCheckHealth).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockCheckHealth).toHaveBeenCalledTimes(2);
  });

  it("stop() prevents further ticks", async () => {
    const app = makeApp({ last_deploy_status: "deployed" });
    const db = makeMockDb([app]);

    handle = startHealthLoop(db);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockCheckHealth).toHaveBeenCalledTimes(1);

    handle.stop();
    handle = null; // already stopped, afterEach should not stop again

    await vi.advanceTimersByTimeAsync(60_000);
    // still 1 — no more ticks after stop
    expect(mockCheckHealth).toHaveBeenCalledTimes(1);
  });
});
