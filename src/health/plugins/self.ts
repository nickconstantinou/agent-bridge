import { existsSync } from "node:fs";
import type { HealthPlugin, HealthReport, CheckResult } from "../types.js";
import type { BridgeDb } from "../../db.js";

export class SelfPlugin implements HealthPlugin {
  readonly name = "agent-bridge";
  private db: BridgeDb;
  private dbPath: string;

  constructor(db: BridgeDb, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  async check(): Promise<HealthReport> {
    const checks: CheckResult[] = [];

    const dbExists = existsSync(this.dbPath);
    checks.push({
      name: "db-file",
      status: dbExists ? "green" : "red",
      message: dbExists ? "DB file accessible" : "DB file not found",
    });

    if (dbExists) {
      try {
        this.db.getLastUpdateId("codex");
        checks.push({ name: "db-read", status: "green", message: "DB read OK" });
      } catch (e) {
        checks.push({ name: "db-read", status: "red", message: `DB error: ${(e as Error).message}` });
      }
    }

    // Process memory (RSS)
    const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    let memStatus: "green" | "amber" | "red" = "green";
    if (rssMB >= 1024) {
      memStatus = "red";
    } else if (rssMB >= 512) {
      memStatus = "amber";
    }
    checks.push({
      name: "process-memory",
      status: memStatus,
      message: `Bridge RSS: ${rssMB} MB`,
      value: rssMB,
    });

    // Circuit breaker state
    let cbStatus: "green" | "amber" | "red" = "green";
    let cbMessage = "No consecutive failures";
    try {
      const failures = this.db.getMaxConsecutiveFailures();
      if (failures.length > 0) {
        const tripped = failures.filter(f => f.count >= 2);
        const warned = failures.filter(f => f.count === 1);
        if (tripped.length > 0) {
          cbStatus = "red";
          cbMessage = `Circuit breaker tripped: ${tripped.map(f => `${f.bot}(${f.count})`).join(", ")}`;
        } else if (warned.length > 0) {
          cbStatus = "amber";
          cbMessage = `1 failure recorded: ${warned.map(f => f.bot).join(", ")}`;
        }
      }
    } catch {
      cbStatus = "amber";
      cbMessage = "Could not read circuit breaker state";
    }
    checks.push({ name: "circuit-breaker", status: cbStatus, message: cbMessage });

    const worst = checks.some(c => c.status === "red") ? "red"
                : checks.some(c => c.status === "amber") ? "amber"
                : "green";

    return {
      pluginName: this.name,
      status: worst,
      checks,
      summary: worst === "green" ? "All systems nominal" : "Issues detected",
      timestamp: new Date().toISOString(),
    };
  }
}
