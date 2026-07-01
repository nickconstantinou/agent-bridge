import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock side-effectful modules at module level
vi.mock("../../src/appliance/exec.js", () => ({
  safeExec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }),
}));

vi.mock("../../src/appliance/state.js", () => {
  const MockApplianceDb = vi.fn().mockImplementation(() => ({}));
  return { ApplianceDb: MockApplianceDb };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("import /etc/caddy/sites-enabled/*.caddy\n"),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe("runInstall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dry run returns all steps skipped", async () => {
    const { runInstall } = await import("../../src/appliance/install.js");
    const result = await runInstall({ dryRun: true });

    expect(result.steps).toHaveLength(5);
    expect(result.steps.every(s => s.status === "skipped")).toBe(true);
    expect(result.success).toBe(true);

    const stepNames = result.steps.map(s => s.name);
    expect(stepNames).toContain("create-user");
    expect(stepNames).toContain("create-dirs");
    expect(stepNames).toContain("init-db");
    expect(stepNames).toContain("caddy-include");
    expect(stepNames).toContain("systemd-reload");
  });

  it("creates user when not found", async () => {
    const { safeExec } = await import("../../src/appliance/exec.js");
    const mockSafeExec = vi.mocked(safeExec);

    // First call: id agentbridge -> not found
    // Second call: useradd -> success
    // Remaining calls: mkdir x3, systemctl -> all ok
    mockSafeExec
      .mockResolvedValueOnce({ stdout: "", stderr: "no such user", code: 1 })
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    const { runInstall } = await import("../../src/appliance/install.js");
    const result = await runInstall();

    const createUserStep = result.steps.find(s => s.name === "create-user");
    expect(createUserStep?.status).toBe("ok");
  });

  it("skips user creation when user exists", async () => {
    const { safeExec } = await import("../../src/appliance/exec.js");
    const mockSafeExec = vi.mocked(safeExec);

    // id agentbridge returns 0 -> user exists
    mockSafeExec.mockResolvedValue({ stdout: "uid=...", stderr: "", code: 0 });

    const { runInstall } = await import("../../src/appliance/install.js");
    const result = await runInstall();

    const createUserStep = result.steps.find(s => s.name === "create-user");
    expect(createUserStep?.status).toBe("skipped");
  });

  it("marks step failed when useradd fails", async () => {
    const { safeExec } = await import("../../src/appliance/exec.js");
    const mockSafeExec = vi.mocked(safeExec);

    // id -> user not found; useradd -> fails
    mockSafeExec
      .mockResolvedValueOnce({ stdout: "", stderr: "no such user", code: 1 })
      .mockResolvedValueOnce({ stdout: "", stderr: "permission denied", code: 1 })
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    const { runInstall } = await import("../../src/appliance/install.js");
    const result = await runInstall();

    const createUserStep = result.steps.find(s => s.name === "create-user");
    expect(createUserStep?.status).toBe("failed");
    expect(createUserStep?.detail).toContain("permission denied");
  });

  it("caddy-include skipped when already present", async () => {
    const { safeExec } = await import("../../src/appliance/exec.js");
    vi.mocked(safeExec).mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    const fsPromises = await import("node:fs/promises");
    const mockReadFile = vi.mocked(fsPromises.readFile);
    const mockWriteFile = vi.mocked(fsPromises.writeFile);

    mockReadFile.mockResolvedValue("import /etc/caddy/sites-enabled/*.caddy\n" as any);

    const { runInstall } = await import("../../src/appliance/install.js");
    const result = await runInstall();

    const caddyStep = result.steps.find(s => s.name === "caddy-include");
    expect(caddyStep?.status).toBe("skipped");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("caddy-include writes when absent", async () => {
    const { safeExec } = await import("../../src/appliance/exec.js");
    vi.mocked(safeExec).mockResolvedValue({ stdout: "", stderr: "", code: 0 });

    const fsPromises = await import("node:fs/promises");
    const mockReadFile = vi.mocked(fsPromises.readFile);
    const mockWriteFile = vi.mocked(fsPromises.writeFile);

    mockReadFile.mockResolvedValue("# Caddyfile\n" as any);
    mockWriteFile.mockResolvedValue(undefined);

    const { runInstall } = await import("../../src/appliance/install.js");
    const result = await runInstall();

    const caddyStep = result.steps.find(s => s.name === "caddy-include");
    expect(caddyStep?.status).toBe("ok");
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("failed step does not abort remaining steps", async () => {
    const { safeExec } = await import("../../src/appliance/exec.js");
    const mockSafeExec = vi.mocked(safeExec);

    // id -> user exists (skip)
    // mkdir /apps -> fails
    // mkdir /etc/caddy/sites-enabled -> fails
    // mkdir /var/lib/agent-bridge -> fails
    // systemctl daemon-reload -> ok
    mockSafeExec
      .mockResolvedValueOnce({ stdout: "uid=...", stderr: "", code: 0 }) // id -> user exists
      .mockResolvedValueOnce({ stdout: "", stderr: "permission denied", code: 1 }) // mkdir /apps
      .mockResolvedValueOnce({ stdout: "", stderr: "permission denied", code: 1 }) // mkdir /etc/caddy/sites-enabled
      .mockResolvedValueOnce({ stdout: "", stderr: "permission denied", code: 1 }) // mkdir /var/lib/agent-bridge
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 }); // systemctl

    const { runInstall } = await import("../../src/appliance/install.js");
    const result = await runInstall();

    // create-dirs should be failed
    const createDirsStep = result.steps.find(s => s.name === "create-dirs");
    expect(createDirsStep?.status).toBe("failed");

    // subsequent steps should still have run
    const initDbStep = result.steps.find(s => s.name === "init-db");
    expect(initDbStep).toBeDefined();
    expect(initDbStep?.status).not.toBeUndefined();

    const systemdStep = result.steps.find(s => s.name === "systemd-reload");
    expect(systemdStep).toBeDefined();

    // overall success should be false
    expect(result.success).toBe(false);
  });
});
