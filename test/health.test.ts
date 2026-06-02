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
