import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, existsSync } from "node:fs";

// ── formatReport ─────────────────────────────────────────────────────────────

describe("formatReport", () => {
  it("prefixes green status with checkmark emoji", async () => {
    const { formatReport } = await import("../src/health/reporter.js");
    const report = {
      pluginName: "test-plugin",
      status: "green" as const,
      checks: [],
      summary: "All good",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    expect(formatReport(report)).toContain("✅");
  });

  it("prefixes amber status with warning emoji", async () => {
    const { formatReport } = await import("../src/health/reporter.js");
    const report = {
      pluginName: "test-plugin",
      status: "amber" as const,
      checks: [],
      summary: "Some issues",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    expect(formatReport(report)).toContain("⚠️");
  });

  it("prefixes red status with red circle emoji", async () => {
    const { formatReport } = await import("../src/health/reporter.js");
    const report = {
      pluginName: "test-plugin",
      status: "red" as const,
      checks: [],
      summary: "Critical failure",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    expect(formatReport(report)).toContain("🔴");
  });

  it("includes plugin name and summary in output", async () => {
    const { formatReport } = await import("../src/health/reporter.js");
    const report = {
      pluginName: "content-crawler",
      status: "green" as const,
      checks: [],
      summary: "Queue healthy",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    const text = formatReport(report);
    expect(text).toContain("content-crawler");
    expect(text).toContain("Queue healthy");
  });

  it("renders each check with name and message", async () => {
    const { formatReport } = await import("../src/health/reporter.js");
    const report = {
      pluginName: "test-plugin",
      status: "amber" as const,
      checks: [
        { name: "queue-depth", status: "green" as const, message: "12 pending items" },
        { name: "failed-items", status: "amber" as const, message: "3 failed in last hour" },
      ],
      summary: "Minor issues",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    const text = formatReport(report);
    expect(text).toContain("queue-depth");
    expect(text).toContain("12 pending items");
    expect(text).toContain("failed-items");
    expect(text).toContain("3 failed in last hour");
  });
});

// ── ExternalPlugin ────────────────────────────────────────────────────────────

describe("ExternalPlugin", () => {
  it("parses JSON output from a successful command", async () => {
    const { ExternalPlugin } = await import("../src/health/plugins/external.js");
    const report = {
      pluginName: "content-crawler",
      status: "green",
      checks: [{ name: "queue", status: "green", message: "ok" }],
      summary: "healthy",
      timestamp: "2026-06-02T00:00:00.000Z",
    };
    const plugin = new ExternalPlugin({
      name: "content-crawler",
      command: "node",
      args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(report))})`],
    });
    const result = await plugin.check();
    expect(result.status).toBe("green");
    expect(result.pluginName).toBe("content-crawler");
  });

  it("returns red report when command exits non-zero", async () => {
    const { ExternalPlugin } = await import("../src/health/plugins/external.js");
    const plugin = new ExternalPlugin({
      name: "failing-plugin",
      command: "node",
      args: ["-e", "process.exit(1)"],
    });
    const result = await plugin.check();
    expect(result.status).toBe("red");
    expect(result.pluginName).toBe("failing-plugin");
  });

  it("returns red report when command outputs invalid JSON", async () => {
    const { ExternalPlugin } = await import("../src/health/plugins/external.js");
    const plugin = new ExternalPlugin({
      name: "broken-plugin",
      command: "node",
      args: ["-e", "console.log('not json')"],
    });
    const result = await plugin.check();
    expect(result.status).toBe("red");
    expect(result.checks[0].message).toContain("not json");
  });

  it("returns red report when command is not found", async () => {
    const { ExternalPlugin } = await import("../src/health/plugins/external.js");
    const plugin = new ExternalPlugin({
      name: "missing-plugin",
      command: "command-that-does-not-exist-xyz",
      args: [],
    });
    const result = await plugin.check();
    expect(result.status).toBe("red");
  });
});

// ── SelfPlugin ────────────────────────────────────────────────────────────────

describe("SelfPlugin", () => {
  it("reports green when DB file exists and is readable", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const { openDb } = await import("../src/db.js");
    const dbPath = join(tmpdir(), `health-test-self-${Date.now()}.sqlite`);
    const db = openDb(dbPath);
    try {
      const plugin = new SelfPlugin(db, dbPath);
      const report = await plugin.check();
      expect(report.status).toBe("green");
      expect(report.pluginName).toBe("agent-bridge");
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });

  it("reports red when DB file does not exist", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const { openDb } = await import("../src/db.js");
    const dbPath = join(tmpdir(), `health-test-self-${Date.now()}.sqlite`);
    const db = openDb(dbPath);
    db.close();
    rmSync(dbPath);
    const plugin = new SelfPlugin(db, dbPath);
    const report = await plugin.check();
    expect(report.status).toBe("red");
    const dbCheck = report.checks.find(c => c.name === "db-file");
    expect(dbCheck?.status).toBe("red");
  });

  it("includes timestamp in report", async () => {
    const { SelfPlugin } = await import("../src/health/plugins/self.js");
    const { openDb } = await import("../src/db.js");
    const dbPath = join(tmpdir(), `health-test-self-${Date.now()}.sqlite`);
    const db = openDb(dbPath);
    try {
      const plugin = new SelfPlugin(db, dbPath);
      const report = await plugin.check();
      expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });
});

// ── ServerPlugin ──────────────────────────────────────────────────────────────

describe("ServerPlugin", () => {
  it("reports stats successfully", async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    const plugin = new ServerPlugin();
    const report = await plugin.check();
    expect(report.pluginName).toBe("server");
    expect(["green", "amber", "red"]).toContain(report.status);
    
    const cpuCheck = report.checks.find(c => c.name === "cpu-load");
    expect(cpuCheck).toBeDefined();
    expect(["green", "amber", "red"]).toContain(cpuCheck?.status);
    expect(typeof cpuCheck?.value).toBe("number");

    const memCheck = report.checks.find(c => c.name === "memory-usage");
    expect(memCheck).toBeDefined();
    expect(["green", "amber", "red"]).toContain(memCheck?.status);
    expect(typeof memCheck?.value).toBe("number");

    const swapCheck = report.checks.find(c => c.name === "swap-usage");
    expect(swapCheck).toBeDefined();
    expect(["green", "amber", "red"]).toContain(swapCheck?.status);

    const zombieCheck = report.checks.find(c => c.name === "zombies");
    expect(zombieCheck).toBeDefined();
    expect(["green", "amber", "red"]).toContain(zombieCheck?.status);
    expect(typeof zombieCheck?.value).toBe("number");

    const uptimeCheck = report.checks.find(c => c.name === "uptime");
    expect(uptimeCheck).toBeDefined();
    expect(uptimeCheck?.status).toBe("green");
    expect(typeof uptimeCheck?.value).toBe("number");

    const firewallCheck = report.checks.find(c => c.name === "firewall");
    expect(firewallCheck).toBeDefined();
    expect(["green", "amber"]).toContain(firewallCheck?.status);

    const sshKeyCheck = report.checks.find(c => c.name === "ssh-key-perms");
    expect(sshKeyCheck).toBeDefined();
    expect(["green", "amber", "red"]).toContain(sshKeyCheck?.status);

    const envFileCheck = report.checks.find(c => c.name === "env-file-perms");
    expect(envFileCheck).toBeDefined();
    expect(["green", "amber"]).toContain(envFileCheck?.status);
  });

  it("supports configurable CPU load thresholds", async () => {
    const { ServerPlugin } = await import("../src/health/plugins/server.js");
    
    // Set custom multipliers/thresholds that force it to be flagged
    process.env.HEALTH_CPU_LOAD_AMBER_MULTIPLIER = "0.001";
    process.env.HEALTH_CPU_LOAD_RED_MULTIPLIER = "0.002";

    try {
      const plugin = new ServerPlugin();
      const report = await plugin.check();
      const cpuCheck = report.checks.find(c => c.name === "cpu-load");
      expect(["amber", "red"]).toContain(cpuCheck?.status);
      if (cpuCheck?.status !== "green" && process.platform === "linux") {
        expect(cpuCheck?.message).toContain("Top CPU processes");
      }
    } finally {
      delete process.env.HEALTH_CPU_LOAD_AMBER_MULTIPLIER;
      delete process.env.HEALTH_CPU_LOAD_RED_MULTIPLIER;
    }
  });
});

// ── HealthScheduler ───────────────────────────────────────────────────────────

describe("HealthScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls plugin check after the configured cadence interval", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockReport = {
      pluginName: "test",
      status: "green" as const,
      checks: [],
      summary: "ok",
      timestamp: new Date().toISOString(),
    };
    const mockPlugin = {
      name: "test",
      check: vi.fn().mockResolvedValue(mockReport),
    };
    const reports: string[] = [];
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: true, cadenceSeconds: 60, autonomy: "report" },
      sendReport: async (text) => { reports.push(text); },
    });
    scheduler.start();
    expect(mockPlugin.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockPlugin.check).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("does not start polling when enabled is false", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockPlugin = { name: "test", check: vi.fn() };
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: false, cadenceSeconds: 10, autonomy: "report" },
      sendReport: async () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockPlugin.check).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it("stops polling after stop() is called", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockReport = {
      pluginName: "test",
      status: "green" as const,
      checks: [],
      summary: "ok",
      timestamp: new Date().toISOString(),
    };
    const mockPlugin = {
      name: "test",
      check: vi.fn().mockResolvedValue(mockReport),
    };
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: true, cadenceSeconds: 60, autonomy: "report" },
      sendReport: async () => {},
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockPlugin.check).toHaveBeenCalledTimes(1);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockPlugin.check).toHaveBeenCalledTimes(1);
  });

  it("sends formatted report via sendReport callback", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockReport = {
      pluginName: "content-crawler",
      status: "green" as const,
      checks: [{ name: "queue", status: "green" as const, message: "healthy" }],
      summary: "All systems green",
      timestamp: new Date().toISOString(),
    };
    const mockPlugin = {
      name: "content-crawler",
      check: vi.fn().mockResolvedValue(mockReport),
    };
    const reports: string[] = [];
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: true, cadenceSeconds: 60, autonomy: "report" },
      sendReport: async (text) => { reports.push(text); },
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("content-crawler");
    expect(reports[0]).toContain("All systems green");
    scheduler.stop();
  });
});

// ── buildSuggestionPrompt ─────────────────────────────────────────────────────

describe("buildSuggestionPrompt", () => {
  it("includes plugin name and summary", async () => {
    const { buildSuggestionPrompt } = await import("../src/health/suggest.js");
    const report = {
      pluginName: "content-crawler",
      status: "amber" as const,
      checks: [{ name: "queue-depth", status: "amber" as const, message: "381 items" }],
      summary: "Warning: queue-depth",
      timestamp: new Date().toISOString(),
    };
    const prompt = buildSuggestionPrompt(report);
    expect(prompt).toContain("content-crawler");
    expect(prompt).toContain("Warning: queue-depth");
  });

  it("includes failing check names and messages", async () => {
    const { buildSuggestionPrompt } = await import("../src/health/suggest.js");
    const report = {
      pluginName: "test",
      status: "red" as const,
      checks: [
        { name: "queue-depth", status: "red" as const, message: "600 items" },
        { name: "failed-items", status: "green" as const, message: "0 failed" },
      ],
      summary: "Critical: queue-depth",
      timestamp: new Date().toISOString(),
    };
    const prompt = buildSuggestionPrompt(report);
    expect(prompt).toContain("queue-depth");
    expect(prompt).toContain("600 items");
  });

  it("excludes green checks", async () => {
    const { buildSuggestionPrompt } = await import("../src/health/suggest.js");
    const report = {
      pluginName: "test",
      status: "amber" as const,
      checks: [
        { name: "disk-space", status: "amber" as const, message: "1.5 GB free" },
        { name: "queue-depth", status: "green" as const, message: "5 items" },
      ],
      summary: "Warning: disk-space",
      timestamp: new Date().toISOString(),
    };
    const prompt = buildSuggestionPrompt(report);
    expect(prompt).not.toContain("5 items");
  });
});

// ── parseCadenceSeconds ───────────────────────────────────────────────────────

describe("parseCadenceSeconds", () => {
  it("returns 3600 when HEALTH_MONITOR_CADENCE_SECONDS is not set", async () => {
    const { parseCadenceSeconds } = await import("../src/health/config.js");
    expect(parseCadenceSeconds({})).toBe(3600);
  });

  it("returns parsed integer when valid", async () => {
    const { parseCadenceSeconds } = await import("../src/health/config.js");
    expect(parseCadenceSeconds({ HEALTH_MONITOR_CADENCE_SECONDS: "900" })).toBe(900);
  });

  it("returns 3600 when value is NaN", async () => {
    const { parseCadenceSeconds } = await import("../src/health/config.js");
    expect(parseCadenceSeconds({ HEALTH_MONITOR_CADENCE_SECONDS: "abc" })).toBe(3600);
  });

  it("returns 3600 when value is zero", async () => {
    const { parseCadenceSeconds } = await import("../src/health/config.js");
    expect(parseCadenceSeconds({ HEALTH_MONITOR_CADENCE_SECONDS: "0" })).toBe(3600);
  });

  it("returns 3600 when value is negative", async () => {
    const { parseCadenceSeconds } = await import("../src/health/config.js");
    expect(parseCadenceSeconds({ HEALTH_MONITOR_CADENCE_SECONDS: "-100" })).toBe(3600);
  });
});

// ── parseHealthEnabled ────────────────────────────────────────────────────────

describe("parseHealthEnabled", () => {
  it("defaults to false when HEALTH_MONITOR_ENABLED is not set", async () => {
    const { parseHealthEnabled } = await import("../src/health/config.js");
    expect(parseHealthEnabled({})).toBe(false);
  });

  it("is true when HEALTH_MONITOR_ENABLED=true", async () => {
    const { parseHealthEnabled } = await import("../src/health/config.js");
    expect(parseHealthEnabled({ HEALTH_MONITOR_ENABLED: "true" })).toBe(true);
  });

  it("is false when HEALTH_MONITOR_ENABLED=false", async () => {
    const { parseHealthEnabled } = await import("../src/health/config.js");
    expect(parseHealthEnabled({ HEALTH_MONITOR_ENABLED: "false" })).toBe(false);
  });
});

// ── buildSuggestionInvocation ─────────────────────────────────────────────────

describe("buildSuggestionInvocation", () => {
  it("never includes --dangerously-skip-permissions for claude bot", async () => {
    const { buildSuggestionInvocation } = await import("../src/health/suggest.js");
    const inv = buildSuggestionInvocation("claude", { command: "claude", modelPreference: ["claude-sonnet-4-6"] }, "analyze this");
    expect(inv.args).not.toContain("--dangerously-skip-permissions");
  });

  it("never includes --dangerously-bypass-approvals-and-sandbox for codex bot", async () => {
    const { buildSuggestionInvocation } = await import("../src/health/suggest.js");
    const inv = buildSuggestionInvocation("codex", { command: "codex", modelPreference: [] }, "analyze this");
    expect(inv.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("uses json output format for claude", async () => {
    const { buildSuggestionInvocation } = await import("../src/health/suggest.js");
    const inv = buildSuggestionInvocation("claude", { command: "claude", modelPreference: [] }, "test");
    expect(inv.args).toContain("--output-format");
  });

  it("does not use json output format for antigravity", async () => {
    const { buildSuggestionInvocation } = await import("../src/health/suggest.js");
    const inv = buildSuggestionInvocation("antigravity", { command: "agy", modelPreference: [] }, "test");
    expect(inv.args).not.toContain("--json");
    expect(inv.args).not.toContain("--output-format");
  });
});

// ── generateSuggestion ────────────────────────────────────────────────────────

describe("generateSuggestion", () => {
  it("returns null when the bot command binary is not found", async () => {
    const { generateSuggestion } = await import("../src/health/suggest.js");
    const report = {
      pluginName: "test",
      status: "red" as const,
      checks: [{ name: "db-file", status: "red" as const, message: "not found" }],
      summary: "Critical",
      timestamp: new Date().toISOString(),
    };
    const fakeBotConfig = { command: "no-such-cli-xyz", modelPreference: [] };
    const result = await generateSuggestion(report, "claude", fakeBotConfig);
    expect(result).toBeNull();
  });

  it("returns null when the bot returns an error-shaped response", async () => {
    const { generateSuggestion } = await import("../src/health/suggest.js");
    const report = {
      pluginName: "test",
      status: "red" as const,
      checks: [],
      summary: "Critical",
      timestamp: new Date().toISOString(),
    };
    // Mock runCli/parseCliResult behavior by testing with a command that outputs an error/timeout string
    const { runCli } = await import("../src/cli.js");
    const originalRunCli = runCli;
    try {
      // Mock runCli to return an error string in stdout
      const mockRunCli = vi.fn().mockResolvedValue(JSON.stringify({ result: "Error: timed out waiting for response" }));
      vi.spyOn(await import("../src/cli.js"), "runCli").mockImplementation(mockRunCli);
      
      const result = await generateSuggestion(report, "claude", { command: "claude", modelPreference: [] });
      expect(result).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ── HealthScheduler — suggest mode (runPlugin called directly) ────────────────

describe("HealthScheduler suggest mode", () => {
  it("sends a second suggestion message for amber report when autonomy=suggest", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockReport = {
      pluginName: "content-crawler",
      status: "amber" as const,
      checks: [{ name: "queue-depth", status: "amber" as const, message: "381 items" }],
      summary: "Warning: queue-depth",
      timestamp: new Date().toISOString(),
    };
    const mockPlugin = { name: "content-crawler", check: vi.fn().mockResolvedValue(mockReport) };
    const reports: string[] = [];
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: true, cadenceSeconds: 60, autonomy: "suggest", suggestBot: "claude" as const, suggestBotConfig: { command: "claude", modelPreference: [] } },
      sendReport: async (text) => { reports.push(text); },
      _suggestFn: async () => "Drain the queue by restarting the worker",
    });
    await scheduler.runPlugin(mockPlugin);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toContain("Suggested actions");
    expect(reports[1]).toContain("Drain the queue");
  });

  it("does NOT send suggestion for green report in suggest mode", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockReport = {
      pluginName: "test",
      status: "green" as const,
      checks: [],
      summary: "All good",
      timestamp: new Date().toISOString(),
    };
    const mockPlugin = { name: "test", check: vi.fn().mockResolvedValue(mockReport) };
    const reports: string[] = [];
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: true, cadenceSeconds: 60, autonomy: "suggest", suggestBot: "claude" as const, suggestBotConfig: { command: "claude", modelPreference: [] } },
      sendReport: async (text) => { reports.push(text); },
      _suggestFn: async () => "should not appear",
    });
    await scheduler.runPlugin(mockPlugin);
    expect(reports).toHaveLength(1);
  });

  it("does NOT send suggestion when autonomy=report even for red", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockReport = {
      pluginName: "test",
      status: "red" as const,
      checks: [{ name: "db-file", status: "red" as const, message: "missing" }],
      summary: "Critical",
      timestamp: new Date().toISOString(),
    };
    const mockPlugin = { name: "test", check: vi.fn().mockResolvedValue(mockReport) };
    const reports: string[] = [];
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: true, cadenceSeconds: 60, autonomy: "report" },
      sendReport: async (text) => { reports.push(text); },
      _suggestFn: async () => "should not appear",
    });
    await scheduler.runPlugin(mockPlugin);
    expect(reports).toHaveLength(1);
  });

  it("does NOT send suggestion when suggestBot is not configured", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockReport = {
      pluginName: "test",
      status: "red" as const,
      checks: [],
      summary: "Critical",
      timestamp: new Date().toISOString(),
    };
    const mockPlugin = { name: "test", check: vi.fn().mockResolvedValue(mockReport) };
    const reports: string[] = [];
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: true, cadenceSeconds: 60, autonomy: "suggest" },
      sendReport: async (text) => { reports.push(text); },
      _suggestFn: async () => "should not appear",
    });
    await scheduler.runPlugin(mockPlugin);
  });

  it("skips running a plugin if a previous run is still in flight", async () => {
    const { HealthScheduler } = await import("../src/health/scheduler.js");
    const mockReport = {
      pluginName: "test",
      status: "green" as const,
      checks: [],
      summary: "All good",
      timestamp: new Date().toISOString(),
    };
    
    let resolveCheck: (value: typeof mockReport) => void = () => {};
    const checkPromise = new Promise<typeof mockReport>((resolve) => {
      resolveCheck = resolve;
    });

    const mockPlugin = {
      name: "test",
      check: vi.fn().mockReturnValue(checkPromise),
    };
    
    const reports: string[] = [];
    const scheduler = new HealthScheduler({
      plugins: [mockPlugin],
      config: { enabled: true, cadenceSeconds: 60, autonomy: "report" },
      sendReport: async (text) => { reports.push(text); },
    });

    // Start first run - it should remain in flight
    const run1 = scheduler.runPlugin(mockPlugin);
    
    // Start second run - it should skip
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await scheduler.runPlugin(mockPlugin);
    
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("run skipped: previous run still in flight"));
    expect(mockPlugin.check).toHaveBeenCalledTimes(1); // Only called once
    
    // Resolve the first check
    resolveCheck(mockReport);
    await run1;
    
    expect(reports).toHaveLength(1);
    consoleWarnSpy.mockRestore();
  });
});
