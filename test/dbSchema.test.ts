import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations, applyMigrationsUpTo, CURRENT_SCHEMA_VERSION, type Migration } from "../src/db/schema.js";
import { openDb } from "../src/db.js";

// All five production entrypoints (index.ts, index-discord-interactive.ts,
// index-worker.ts, index-health.ts, index-interactive.ts) call the same
// openDb() against the same schema — verified by inspection of each
// entrypoint's openDb() call site. The roles differ only by serviceId and
// database file path, so one fixed legacy-shape fixture is parameterized
// across all five rather than duplicated per role.
const ROLE_FIXTURES = ["shared", "discord", "health", "interactive", "worker"] as const;

function tempDbPath(role: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), `agent-bridge-schema-${role}-`));
  return { dir, path: join(dir, "bridge.sqlite") };
}

/**
 * Fixed pre-versioned SQL modeling the actual legacy on-disk shape observed
 * before schema versioning existed: no user_version marker (defaults to 0),
 * execution_locks missing acquisition_id (triggers the rename-repair),
 * work_items/work_jobs CHECK constraints missing later-added enum values
 * (triggers the rename-recreate repairs), bridge_state/github_links missing
 * later-added columns (triggers the ALTER TABLE ADD COLUMN repairs), and no
 * conversation-persistence or project-memory tables at all (triggers their
 * CREATE TABLE IF NOT EXISTS creation). This is built with raw SQL, not via
 * openDb(), so it stays a stable regression fixture independent of future
 * changes to the migration itself.
 */
function createLegacyFixture(path: string): void {
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE bridge_state (
      chat_id               TEXT    PRIMARY KEY,
      codex_session_id      TEXT,
      gemini_session_id     TEXT,
      active_execution_lock INTEGER NOT NULL DEFAULT 0,
      last_update_id        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE execution_locks (
      surface     TEXT NOT NULL,
      chat_key    TEXT NOT NULL,
      service_id  TEXT NOT NULL,
      run_id      TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      PRIMARY KEY (surface, chat_key)
    );
    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE work_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK (kind IN ('defect','feature','maintenance','research','ops')),
      source      TEXT NOT NULL CHECK (source IN ('telegram','health','defect_scan','schedule','github','manual')),
      repository  TEXT,
      title       TEXT NOT NULL,
      body        TEXT,
      status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','needs_approval','approved','in_progress','blocked','resolved','closed','rejected')),
      priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE work_jobs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id     INTEGER,
      task_type        TEXT NOT NULL CHECK (task_type IN ('defect_scan','feature_plan','feature_research','implementation_plan','run_tdd_fix','open_github_issue','open_pull_request','verify_pull_request','ops_check','tdd_implementation')),
      status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','running','waiting_approval','completed','failed','cancelled')),
      bot              TEXT CHECK (bot IN ('codex','antigravity','claude')),
      lease_owner      TEXT,
      lease_expires_at TEXT,
      heartbeat_at     TEXT,
      attempt_count    INTEGER NOT NULL DEFAULT 0,
      max_attempts     INTEGER NOT NULL DEFAULT 2,
      idempotency_key  TEXT NOT NULL UNIQUE,
      input_json       TEXT NOT NULL DEFAULT '{}',
      result_json      TEXT,
      error            TEXT,
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );
    CREATE TABLE approvals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id  INTEGER,
      job_id        INTEGER,
      approval_type TEXT NOT NULL CHECK (approval_type IN ('create_issue','start_implementation','push_branch','open_pr','merge_pr','restart_service','cancel_job')),
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
      requested_by  TEXT NOT NULL,
      requested_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_by    TEXT,
      decided_at    TEXT,
      expires_at    TEXT,
      payload_json  TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(work_item_id) REFERENCES work_items(id),
      FOREIGN KEY(job_id) REFERENCES work_jobs(id)
    );
    CREATE TABLE github_links (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL,
      repository   TEXT NOT NULL,
      issue_number INTEGER,
      pr_number    INTEGER,
      branch_name  TEXT,
      commit_sha   TEXT,
      remote_url   TEXT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository, issue_number),
      UNIQUE(repository, pr_number),
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );
    CREATE TABLE prompts (
      name        TEXT    PRIMARY KEY,
      prompt_text TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  raw.close();
}

describe("database schema versioning", () => {
  it.each(ROLE_FIXTURES)("migrates the %s legacy database role from a fixed pre-versioned fixture", (role) => {
    const fixture = tempDbPath(role);
    try {
      createLegacyFixture(fixture.path);
      const db = openDb(fixture.path, { serviceId: `schema-test:${role}` });
      expect(db.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);

      // Historical repairs actually ran: execution_locks gained acquisition_id,
      // work_items/work_jobs CHECK constraints were widened, bridge_state and
      // github_links gained their later columns, and the conversation/memory
      // tables introduced after versioning now exist.
      const lockColumns = (db.raw.prepare(`PRAGMA table_info(execution_locks)`).all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(lockColumns).toContain("acquisition_id");

      const workItemsSql = (db.raw.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'`
      ).get() as { sql: string }).sql;
      expect(workItemsSql).toContain("'refactor'");

      const workJobsSql = (db.raw.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='work_jobs'`
      ).get() as { sql: string }).sql;
      expect(workJobsSql).toContain("'orchestrated_task'");

      const bridgeStateColumns = (db.raw.prepare(`PRAGMA table_info(bridge_state)`).all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(bridgeStateColumns).toEqual(expect.arrayContaining(["claude_session_id", "antigravity_session_id", "kimchi_session_id"]));

      for (const table of ["conversation_turns", "pending_messages", "conversation_summaries", "compaction_attempts", "project_memories"]) {
        expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeTruthy();
      }
      db.close();

      // Reopening an already-migrated (version 1) database must not re-run
      // the repair path — user_version is authoritative once at 1.
      const reopened = openDb(fixture.path, { serviceId: `schema-test:${role}` });
      expect(reopened.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      reopened.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("keeps a fresh database at the current version after an idempotent reopen", () => {
    const fixture = tempDbPath("fresh");
    try {
      const first = openDb(fixture.path);
      first.close();
      const second = openDb(fixture.path);
      expect(second.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      second.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("fails closed for a future schema version without changing the database, WAL mode, or sidecar files", () => {
    const fixture = tempDbPath("future");
    try {
      const raw = new Database(fixture.path);
      raw.exec("CREATE TABLE sentinel(value TEXT); PRAGMA user_version = 99;");
      raw.close();

      const beforeHash = createHash("sha256").update(readFileSync(fixture.path)).digest("hex");
      const walPath = `${fixture.path}-wal`;
      const shmPath = `${fixture.path}-shm`;

      expect(() => openDb(fixture.path)).toThrow(/unsupported database schema version 99/i);

      // No WAL/shm sidecar files were ever created — proves WAL mode was
      // never enabled before the rejection.
      expect(existsSync(walPath)).toBe(false);
      expect(existsSync(shmPath)).toBe(false);

      const afterHash = createHash("sha256").update(readFileSync(fixture.path)).digest("hex");
      expect(afterHash).toBe(beforeHash);

      const verify = new Database(fixture.path, { readonly: true });
      expect(verify.pragma("journal_mode", { simple: true })).toBe("delete");
      expect(verify.pragma("user_version", { simple: true })).toBe(99);
      expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'sentinel'").get()).toBeTruthy();
      verify.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rolls back schema changes and user_version when an intermediate migration fails", () => {
    const fixture = tempDbPath("rollback");
    const migrations: readonly Migration[] = [
      { version: 1, name: "create_probe", up: (db) => db.exec("CREATE TABLE probe(value TEXT)") },
      { version: 2, name: "fail_probe", up: (db) => {
        db.exec("ALTER TABLE probe ADD COLUMN changed INTEGER");
        throw new Error("deliberate migration failure");
      } },
    ];
    try {
      const raw = new Database(fixture.path);
      // Uses the explicit-target test helper (targetVersion 2) because this
      // two-step scenario intentionally exceeds CURRENT_SCHEMA_VERSION (1).
      // Production code always calls applyMigrations(), which never accepts
      // an override and rejects any plan that doesn't end exactly at
      // CURRENT_SCHEMA_VERSION.
      expect(() => applyMigrationsUpTo(raw, migrations, 2)).toThrow("deliberate migration failure");
      expect(raw.pragma("user_version", { simple: true })).toBe(0);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'probe'").get()).toBeUndefined();
      raw.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects a production migration plan that does not end exactly at CURRENT_SCHEMA_VERSION", () => {
    const fixture = tempDbPath("overshoot");
    const overshootMigrations: readonly Migration[] = [
      { version: 1, name: "legacy-compatible-baseline", up: () => undefined },
      { version: 2, name: "unexpected-extra-step", up: () => undefined },
    ];
    try {
      const raw = new Database(fixture.path);
      expect(() => applyMigrations(raw, overshootMigrations)).toThrow(
        `database migrations must end exactly at target schema version ${CURRENT_SCHEMA_VERSION}`,
      );
      expect(raw.pragma("user_version", { simple: true })).toBe(0);
      raw.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
