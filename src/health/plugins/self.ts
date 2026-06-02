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
        // Use an existing read operation as a liveness check
        this.db.getLastUpdateId("codex");
        checks.push({ name: "db-read", status: "green", message: "DB read OK" });
      } catch (e) {
        checks.push({ name: "db-read", status: "red", message: `DB error: ${(e as Error).message}` });
      }
    }

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
