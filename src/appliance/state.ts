import Database, { type Database as BetterDB } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AppState {
  name: string; repo: string; branch: string; port: number; domain: string;
  runtime: string; current_commit: string | null; previous_commit: string | null;
  service_name: string; last_deploy_status: string | null; last_health_status: string | null;
  last_deployed_at: string | null; last_error: string | null;
}

export interface Incident {
  id: number; app_name: string; detected_at: string; health_url: string;
  http_status: number | null; error: string | null; logs: string | null; resolved_at: string | null;
}

const DEFAULT_DB_PATH = process.env.APPLIANCE_STATE_DB ?? "/var/lib/agent-bridge/state.db";

export class ApplianceDb {
  private db: BetterDB;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        name TEXT PRIMARY KEY,
        repo TEXT NOT NULL, branch TEXT NOT NULL, port INTEGER NOT NULL,
        domain TEXT NOT NULL, runtime TEXT NOT NULL, service_name TEXT NOT NULL,
        current_commit TEXT, previous_commit TEXT,
        last_deploy_status TEXT, last_health_status TEXT,
        last_deployed_at TEXT, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name TEXT NOT NULL, detected_at TEXT NOT NULL,
        health_url TEXT NOT NULL, http_status INTEGER,
        error TEXT, logs TEXT, resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS port_seq (next INTEGER NOT NULL DEFAULT 10000);
      INSERT OR IGNORE INTO port_seq (rowid, next) VALUES (1, 10000);
    `);
  }

  close(): void { this.db.close(); }

  upsertApp(state: Omit<AppState, "service_name"> & { service_name?: string }): void {
    const service_name = state.service_name ?? `ab-${state.name}`;
    this.db.prepare(`
      INSERT INTO apps (name, repo, branch, port, domain, runtime, service_name,
        current_commit, previous_commit, last_deploy_status, last_health_status,
        last_deployed_at, last_error)
      VALUES (@name, @repo, @branch, @port, @domain, @runtime, @service_name,
        @current_commit, @previous_commit, @last_deploy_status, @last_health_status,
        @last_deployed_at, @last_error)
      ON CONFLICT(name) DO UPDATE SET
        repo=excluded.repo, branch=excluded.branch, port=excluded.port,
        domain=excluded.domain, runtime=excluded.runtime, service_name=excluded.service_name,
        current_commit=excluded.current_commit, previous_commit=excluded.previous_commit,
        last_deploy_status=excluded.last_deploy_status, last_health_status=excluded.last_health_status,
        last_deployed_at=excluded.last_deployed_at, last_error=excluded.last_error
    `).run({ ...state, service_name });
  }

  getApp(name: string): AppState | null {
    return (this.db.prepare("SELECT * FROM apps WHERE name = ?").get(name) as AppState | undefined) ?? null;
  }

  listApps(): AppState[] {
    return this.db.prepare("SELECT * FROM apps ORDER BY name").all() as AppState[];
  }

  deleteApp(name: string): void {
    this.db.prepare("DELETE FROM apps WHERE name = ?").run(name);
  }

  allocatePort(): number {
    const usedPorts = new Set<number>(
      (this.db.prepare("SELECT port FROM apps").all() as { port: number }[]).map(r => r.port)
    );
    const row = this.db.prepare("SELECT next FROM port_seq WHERE rowid = 1").get() as { next: number } | undefined;
    if (!row) throw new Error("port_seq row missing — DB may be corrupted");
    let port = row.next;
    while (usedPorts.has(port)) {
      port++;
      if (port > 19999) throw new Error("Port pool exhausted (10000-19999)");
    }
    if (port > 19999) throw new Error("Port pool exhausted (10000-19999)");
    this.db.prepare("UPDATE port_seq SET next = ? WHERE rowid = 1").run(port + 1);
    return port;
  }

  insertIncident(inc: Omit<Incident, "id">): number {
    const result = this.db.prepare(`
      INSERT INTO incidents (app_name, detected_at, health_url, http_status, error, logs, resolved_at)
      VALUES (@app_name, @detected_at, @health_url, @http_status, @error, @logs, @resolved_at)
    `).run(inc);
    return Number(result.lastInsertRowid);
  }

  resolveIncident(id: number, resolvedAt: string): void {
    this.db.prepare("UPDATE incidents SET resolved_at = ? WHERE id = ?").run(resolvedAt, id);
  }

  getOpenIncidents(appName: string): Incident[] {
    return this.db.prepare(
      "SELECT * FROM incidents WHERE app_name = ? AND resolved_at IS NULL ORDER BY detected_at DESC"
    ).all(appName) as Incident[];
  }
}
