import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Shared listApps mock so tests can configure the return value
const mockListApps = vi.fn().mockReturnValue([]);

// Mock ApplianceDb using a constructor function (not arrow fn) so `new` works
vi.mock("../../src/appliance/state.js", () => {
  return {
    ApplianceDb: function MockApplianceDb() {
      this.listApps = mockListApps;
      this.close = vi.fn();
    },
  };
});

// Mock all appliance modules
vi.mock("../../src/appliance/install.js", () => ({
  runInstall: vi.fn().mockResolvedValue({ steps: [], success: true }),
}));

vi.mock("../../src/appliance/app-init.js", () => ({
  appInit: vi.fn().mockResolvedValue({ name: "testapp", repo: "git@github.com:x/y.git", branch: "main", port: 10000, domain: "app.example.com" }),
}));

vi.mock("../../src/appliance/deploy.js", () => ({
  deployApp: vi.fn().mockResolvedValue({ commit: "abc123", healthOk: true, healthStatus: 200, error: null }),
}));

vi.mock("../../src/appliance/rollback.js", () => ({
  rollbackApp: vi.fn().mockResolvedValue({ previousCommit: "deadbeef", healthOk: true, error: null }),
}));

vi.mock("../../src/appliance/app-ops.js", () => ({
  appStatus: vi.fn().mockResolvedValue({ name: "testapp", domain: "app.example.com", port: 10000, commit: "abc123", systemdStatus: "active", healthResult: { ok: true, status: 200, error: null }, lastDeployStatus: "success", lastDeployedAt: "2026-01-01T00:00:00Z", lastError: null }),
  appLogs: vi.fn().mockResolvedValue("log line 1\nlog line 2\n"),
  appRestart: vi.fn().mockResolvedValue(undefined),
}));

describe("CLI runCli", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as (code?: number) => never);
    vi.clearAllMocks();
    mockListApps.mockReturnValue([]);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it("install --dry-run calls runInstall with dryRun:true", async () => {
    const { runCli } = await import("../../scripts/appliance.js");
    const { runInstall } = await import("../../src/appliance/install.js");

    await runCli(["install", "--dry-run"]);

    expect(vi.mocked(runInstall)).toHaveBeenCalledWith({ dryRun: true });
  });

  it("install without --dry-run calls runInstall with dryRun:false", async () => {
    const { runCli } = await import("../../scripts/appliance.js");
    const { runInstall } = await import("../../src/appliance/install.js");

    await runCli(["install"]);

    expect(vi.mocked(runInstall)).toHaveBeenCalledWith({ dryRun: false });
  });

  it("app deploy <name> calls deployApp", async () => {
    const { runCli } = await import("../../scripts/appliance.js");
    const { deployApp } = await import("../../src/appliance/deploy.js");

    await runCli(["app", "deploy", "myapp"]);

    expect(vi.mocked(deployApp)).toHaveBeenCalledWith(expect.anything(), "myapp");
  });

  it("app rollback <name> calls rollbackApp", async () => {
    const { runCli } = await import("../../scripts/appliance.js");
    const { rollbackApp } = await import("../../src/appliance/rollback.js");

    await runCli(["app", "rollback", "myapp"]);

    expect(vi.mocked(rollbackApp)).toHaveBeenCalledWith(expect.anything(), "myapp");
  });

  it("app status <name> calls appStatus and prints JSON", async () => {
    const { runCli } = await import("../../scripts/appliance.js");
    const { appStatus } = await import("../../src/appliance/app-ops.js");

    await runCli(["app", "status", "myapp"]);

    expect(vi.mocked(appStatus)).toHaveBeenCalledWith(expect.anything(), "myapp");
    expect(consoleLogSpy).toHaveBeenCalled();
    const output = consoleLogSpy.mock.calls[0][0] as string;
    expect(output).toContain("testapp");
  });

  it("app logs <name> calls appLogs and prints output", async () => {
    const { runCli } = await import("../../scripts/appliance.js");
    const { appLogs } = await import("../../src/appliance/app-ops.js");

    await runCli(["app", "logs", "myapp"]);

    expect(vi.mocked(appLogs)).toHaveBeenCalledWith(expect.anything(), "myapp", 100);
    expect(consoleLogSpy).toHaveBeenCalled();
    const output = consoleLogSpy.mock.calls[0][0] as string;
    expect(output).toContain("log line 1");
  });

  it("app logs <name> --lines <n> passes lines count", async () => {
    const { runCli } = await import("../../scripts/appliance.js");
    const { appLogs } = await import("../../src/appliance/app-ops.js");

    await runCli(["app", "logs", "myapp", "--lines", "50"]);

    expect(vi.mocked(appLogs)).toHaveBeenCalledWith(expect.anything(), "myapp", 50);
  });

  it("app restart <name> calls appRestart", async () => {
    const { runCli } = await import("../../scripts/appliance.js");
    const { appRestart } = await import("../../src/appliance/app-ops.js");

    await runCli(["app", "restart", "myapp"]);

    expect(vi.mocked(appRestart)).toHaveBeenCalledWith(expect.anything(), "myapp");
  });

  it("app list calls listApps and prints app names", async () => {
    mockListApps.mockReturnValue([
      { name: "alpha", port: 10000, last_deploy_status: "success", current_commit: "abc123", domain: "alpha.example.com", repo: "git@github.com:x/alpha.git", branch: "main", runtime: "node", service_name: "ab-alpha", previous_commit: null, last_health_status: null, last_deployed_at: null, last_error: null },
      { name: "beta", port: 10001, last_deploy_status: null, current_commit: null, domain: "beta.example.com", repo: "git@github.com:x/beta.git", branch: "main", runtime: "node", service_name: "ab-beta", previous_commit: null, last_health_status: null, last_deployed_at: null, last_error: null },
    ]);

    const { runCli } = await import("../../scripts/appliance.js");
    await runCli(["app", "list"]);

    const allOutput = consoleLogSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(allOutput).toContain("alpha");
    expect(allOutput).toContain("beta");
  });

  it("unknown command prints error and exits with 1", async () => {
    const { runCli } = await import("../../scripts/appliance.js");

    await runCli(["unknown-command"]);

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it("app init calls appInit with correct args", async () => {
    const { runCli } = await import("../../scripts/appliance.js");
    const { appInit } = await import("../../src/appliance/app-init.js");

    await runCli(["app", "init", "myapp", "--repo", "git@github.com:x/y.git", "--domain", "myapp.example.com"]);

    expect(vi.mocked(appInit)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "myapp", repo: "git@github.com:x/y.git", domain: "myapp.example.com" })
    );
  });
});
