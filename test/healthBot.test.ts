import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";

describe("HealthBridgeBot", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `health-bot-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("sends formatted report to Telegram when handleReport is called", async () => {
    const { HealthBridgeBot } = await import("../src/health/bot.js");
    const sent: string[] = [];
    const bot = new HealthBridgeBot({
      db,
      chatId: 12345,
      sessionTtlSeconds: 1800,
      autonomy: "report",
      cliBot: "claude",
      cliBotConfig: { command: "claude", modelPreference: [] },
      _sendText: async (text) => { sent.push(text); },
      _suggestFn: async () => "suggest",
    });
    const report = {
      pluginName: "test",
      status: "red" as const,
      checks: [{ name: "db", status: "red" as const, message: "missing" }],
      summary: "Critical",
      timestamp: new Date().toISOString(),
    };
    await bot.handleReport(report);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("test");
  });

  it("sends suggestion after report when autonomy=suggest and status is not green", async () => {
    const { HealthBridgeBot } = await import("../src/health/bot.js");
    const sent: string[] = [];
    const bot = new HealthBridgeBot({
      db,
      chatId: 12345,
      sessionTtlSeconds: 1800,
      autonomy: "suggest",
      cliBot: "claude",
      cliBotConfig: { command: "claude", modelPreference: [] },
      _sendText: async (text) => { sent.push(text); },
      _suggestFn: async () => "Restart the worker",
    });
    const report = {
      pluginName: "content-crawler",
      status: "amber" as const,
      checks: [],
      summary: "Queue elevated",
      timestamp: new Date().toISOString(),
    };
    await bot.handleReport(report);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("Restart the worker");
  });

  it("does not send suggestion when autonomy=report even for red status", async () => {
    const { HealthBridgeBot } = await import("../src/health/bot.js");
    const sent: string[] = [];
    const bot = new HealthBridgeBot({
      db,
      chatId: 12345,
      sessionTtlSeconds: 1800,
      autonomy: "report",
      cliBot: "claude",
      cliBotConfig: { command: "claude", modelPreference: [] },
      _sendText: async (text) => { sent.push(text); },
      _suggestFn: async () => "should not appear",
    });
    const report = {
      pluginName: "test",
      status: "red" as const,
      checks: [],
      summary: "Critical",
      timestamp: new Date().toISOString(),
    };
    await bot.handleReport(report);
    expect(sent).toHaveLength(1);
  });

  it("does not send suggestion for green report", async () => {
    const { HealthBridgeBot } = await import("../src/health/bot.js");
    const sent: string[] = [];
    const bot = new HealthBridgeBot({
      db,
      chatId: 12345,
      sessionTtlSeconds: 1800,
      autonomy: "suggest",
      cliBot: "claude",
      cliBotConfig: { command: "claude", modelPreference: [] },
      _sendText: async (text) => { sent.push(text); },
      _suggestFn: async () => "should not appear",
    });
    const report = {
      pluginName: "test",
      status: "green" as const,
      checks: [],
      summary: "All good",
      timestamp: new Date().toISOString(),
    };
    await bot.handleReport(report);
    expect(sent).toHaveLength(1);
  });

  it("stores report and suggestion in context store", async () => {
    const { HealthBridgeBot } = await import("../src/health/bot.js");
    const { HealthContextStore } = await import("../src/health/context.js");
    const bot = new HealthBridgeBot({
      db,
      chatId: 12345,
      sessionTtlSeconds: 1800,
      autonomy: "suggest",
      cliBot: "claude",
      cliBotConfig: { command: "claude", modelPreference: [] },
      _sendText: async () => {},
      _suggestFn: async () => "Run: systemctl restart worker",
    });
    const report = {
      pluginName: "content-crawler",
      status: "red" as const,
      checks: [],
      summary: "Queue broken",
      timestamp: new Date().toISOString(),
    };
    await bot.handleReport(report);
    const store = new HealthContextStore(db);
    const ctx = store.getContext();
    expect(ctx?.lastReport?.pluginName).toBe("content-crawler");
    expect(ctx?.lastSuggestion).toBe("Run: systemctl restart worker");
  });

  it("buildOnDemandPrompt returns prompt with context prefix when context exists", async () => {
    const { HealthBridgeBot } = await import("../src/health/bot.js");
    const { HealthContextStore } = await import("../src/health/context.js");
    const store = new HealthContextStore(db);
    store.saveReport({
      pluginName: "crawler",
      status: "amber" as const,
      checks: [],
      summary: "Queue elevated",
      timestamp: new Date().toISOString(),
    });
    store.saveSuggestion("Drain the queue");
    const bot = new HealthBridgeBot({
      db,
      chatId: 12345,
      sessionTtlSeconds: 1800,
      autonomy: "report",
      cliBot: "claude",
      cliBotConfig: { command: "claude", modelPreference: [] },
      _sendText: async () => {},
      _suggestFn: async () => null,
    });
    const prompt = bot.buildOnDemandPrompt("what should I do?");
    expect(prompt).toContain("Queue elevated");
    expect(prompt).toContain("Drain the queue");
    expect(prompt).toContain("what should I do?");
  });
});
