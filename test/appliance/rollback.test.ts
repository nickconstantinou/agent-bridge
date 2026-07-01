import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApplianceDb } from "../../src/appliance/state.js";

// Mock all side-effectful modules at module level
vi.mock("../../src/appliance/exec.js", () => ({
  safeExec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }),
}));

vi.mock("../../src/appliance/systemd.js", () => ({
  restartUnit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/appliance/health.js", () => ({
  checkHealth: vi.fn().mockResolvedValue({ ok: true, status: 200, latencyMs: 50, error: null }),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(
    "name: myapp\nruntime: node\nrepo: git@github.com:x/y.git\nbranch: main\nport: 10000\ndomain: myapp.example.com\ndatabase: sqlite\nhealth: /health\nbuild: npm run build\nstart: npm run start\n"
  ),
}));

describe("rollbackApp", () => {
  let db: ApplianceDb;

  beforeEach(() => {
    db = new ApplianceDb(":memory:");
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it("returns error when app not found", async () => {
    const { rollbackApp } = await import("../../src/appliance/rollback.js");
    const result = await rollbackApp(db, "ghost");
    expect(result.healthOk).toBe(false);
    expect(result.previousCommit).toBe("");
    expect(result.error).toMatch(/not found/i);
  });

  it("returns error when no previous commit", async () => {
    db.upsertApp({
      name: "fresh-app",
      repo: "git@github.com:x/y.git",
      branch: "main",
      port: 3001,
      domain: "fresh.example.com",
      runtime: "node",
      current_commit: "abc",
      previous_commit: null,
      last_deploy_status: null,
      last_health_status: null,
      last_deployed_at: null,
      last_error: null,
    });
    const { rollbackApp } = await import("../../src/appliance/rollback.js");
    const result = await rollbackApp(db, "fresh-app");
    expect(result.healthOk).toBe(false);
    expect(result.previousCommit).toBe("");
    expect(result.error).toMatch(/no previous commit/i);
  });

  it("performs successful rollback", async () => {
    db.upsertApp({
      name: "myapp",
      repo: "git@github.com:x/y.git",
      branch: "main",
      port: 10000,
      domain: "myapp.example.com",
      runtime: "node",
      current_commit: "abc",
      previous_commit: "def",
      last_deploy_status: "deployed",
      last_health_status: null,
      last_deployed_at: null,
      last_error: null,
    });

    const { rollbackApp } = await import("../../src/appliance/rollback.js");
    const result = await rollbackApp(db, "myapp");

    expect(result).toEqual({ previousCommit: "def", healthOk: true, error: null });

    const state = db.getApp("myapp");
    expect(state?.current_commit).toBe("def");
    expect(state?.previous_commit).toBe("abc");
    expect(state?.last_deploy_status).toBe("rollback-success");
  });

  it("returns rollback-unhealthy when health check fails", async () => {
    db.upsertApp({
      name: "myapp",
      repo: "git@github.com:x/y.git",
      branch: "main",
      port: 10000,
      domain: "myapp.example.com",
      runtime: "node",
      current_commit: "abc",
      previous_commit: "def",
      last_deploy_status: "deployed",
      last_health_status: null,
      last_deployed_at: null,
      last_error: null,
    });

    const { checkHealth } = await import("../../src/appliance/health.js");
    vi.mocked(checkHealth).mockResolvedValueOnce({ ok: false, status: 503, latencyMs: 100, error: "Service Unavailable" });

    const { rollbackApp } = await import("../../src/appliance/rollback.js");
    const result = await rollbackApp(db, "myapp");

    expect(result.previousCommit).toBe("def");
    expect(result.healthOk).toBe(false);
    expect(result.error).toBeNull();

    const state = db.getApp("myapp");
    expect(state?.current_commit).toBe("def");
    expect(state?.previous_commit).toBe("abc");
    expect(state?.last_deploy_status).toBe("rollback-unhealthy");
  });

  it("returns error object if git checkout fails via exception", async () => {
    db.upsertApp({
      name: "myapp",
      repo: "git@github.com:x/y.git",
      branch: "main",
      port: 10000,
      domain: "myapp.example.com",
      runtime: "node",
      current_commit: "abc",
      previous_commit: "def",
      last_deploy_status: "deployed",
      last_health_status: null,
      last_deployed_at: null,
      last_error: null,
    });

    const { safeExec } = await import("../../src/appliance/exec.js");
    vi.mocked(safeExec).mockRejectedValueOnce(new Error("git: command not found"));

    const { rollbackApp } = await import("../../src/appliance/rollback.js");
    const result = await rollbackApp(db, "myapp");

    expect(result.healthOk).toBe(false);
    expect(result.error).toMatch(/git: command not found/);
  });
});
