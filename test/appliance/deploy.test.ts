import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApplianceDb } from "../../src/appliance/state.js";

// Mock all side-effectful modules at module level
vi.mock("../../src/appliance/exec.js", () => ({
  safeExec: vi.fn().mockResolvedValue({ stdout: "abc123\n", stderr: "", code: 0 }),
}));

vi.mock("../../src/appliance/systemd.js", () => ({
  generateUnit: vi.fn().mockReturnValue("[Unit]\n"),
  writeUnit: vi.fn().mockResolvedValue(undefined),
  reloadDaemon: vi.fn().mockResolvedValue(undefined),
  enableUnit: vi.fn().mockResolvedValue(undefined),
  restartUnit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/appliance/caddy.js", () => ({
  writeCaddyBlock: vi.fn().mockResolvedValue(undefined),
  reloadCaddy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/appliance/health.js", () => ({
  checkHealth: vi.fn().mockResolvedValue({ ok: true, status: 200, latencyMs: 5, error: null }),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, writeFile: vi.fn().mockResolvedValue(undefined), chmod: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn().mockReturnValue(true),
    readdirSync: vi.fn().mockReturnValue(["HEAD"]),
    readFileSync: vi.fn().mockReturnValue(
      "name: my-app\nruntime: node\nrepo: git@github.com:x/y.git\nbranch: main\nport: 3000\ndomain: app.example.com\ndatabase: sqlite\nhealth: /health\nbuild: skip\nstart: npm run start\n"
    ),
  };
});

describe("deployApp state tracking", () => {
  let db: ApplianceDb;

  beforeEach(() => {
    db = new ApplianceDb(":memory:");
    db.upsertApp({
      name: "my-app",
      repo: "git@github.com:x/y.git",
      branch: "main",
      port: 3000,
      domain: "app.example.com",
      runtime: "node",
      current_commit: null,
      previous_commit: null,
      last_deploy_status: null,
      last_health_status: null,
      last_deployed_at: null,
      last_error: null,
    });
  });

  afterEach(() => { db.close(); });

  it("throws for unknown app", async () => {
    const { deployApp } = await import("../../src/appliance/deploy.js");
    await expect(deployApp(db, "nonexistent")).rejects.toThrow("not found");
  });

  it("returns DeployResult with error=null on success", async () => {
    const { deployApp } = await import("../../src/appliance/deploy.js");
    const result = await deployApp(db, "my-app");
    expect(result.error).toBeNull();
    expect(typeof result.commit).toBe("string");
    expect(result.commit.length).toBeGreaterThan(0);
    expect(result.healthOk).toBe(true);
    expect(result.healthStatus).toBe(200);
  });

  it("updates current_commit and last_deploy_status in DB on success", async () => {
    const { deployApp } = await import("../../src/appliance/deploy.js");
    await deployApp(db, "my-app");
    const state = db.getApp("my-app");
    expect(state?.current_commit).toBe("abc123");
    expect(state?.last_deploy_status).toBe("success");
    expect(state?.last_deployed_at).not.toBeNull();
    expect(state?.last_error).toBeNull();
  });

  it("sets previous_commit from prior current_commit", async () => {
    db.upsertApp({
      name: "my-app",
      repo: "git@github.com:x/y.git",
      branch: "main",
      port: 3000,
      domain: "app.example.com",
      runtime: "node",
      current_commit: "deadbeef",
      previous_commit: null,
      last_deploy_status: null,
      last_health_status: null,
      last_deployed_at: null,
      last_error: null,
    });
    const { deployApp } = await import("../../src/appliance/deploy.js");
    await deployApp(db, "my-app");
    const state = db.getApp("my-app");
    expect(state?.previous_commit).toBe("deadbeef");
  });
});
