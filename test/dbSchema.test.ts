import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations, applyMigrationsUpTo, CURRENT_SCHEMA_VERSION, MigrationForeignKeyViolationError, type Migration } from "../src/db/schema.js";
import { applyLegacyCompatibleBaseline } from "../src/db/legacyBaselineMigration.js";
import { LegacyPromptOverridesPresentError } from "../src/db/dropLegacyPromptOverridesMigration.js";
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
  raw.pragma("foreign_keys = ON");
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
  // Linked rows across work_items -> work_jobs -> approvals/github_links, with
  // foreign_keys enforcement ON at creation time (matching a real production
  // instance). Exercises the rename-recreate repairs under real FK pressure,
  // not just against an empty schema.
  raw.exec(`
    INSERT INTO bridge_state (chat_id, codex_session_id, gemini_session_id, active_execution_lock, last_update_id)
    VALUES ('chat:legacy', 'codex-session-1', 'gemini-session-1', 0, 42);
    INSERT INTO work_items (id, kind, source, title, status, priority, created_by)
    VALUES (1, 'feature', 'telegram', 'Legacy work item', 'approved', 'normal', 'nick');
    INSERT INTO work_jobs (id, work_item_id, task_type, status, idempotency_key)
    VALUES (1, 1, 'implementation_plan', 'completed', 'legacy-job-1');
    INSERT INTO approvals (id, work_item_id, job_id, approval_type, status, requested_by)
    VALUES (1, 1, 1, 'merge_pr', 'approved', 'nick');
    INSERT INTO github_links (id, work_item_id, repository, pr_number)
    VALUES (1, 1, 'nickconstantinou/agent-bridge', 147);
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
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompts'").get()).toBeUndefined();

      // The linked work_items -> work_jobs -> approvals/github_links chain
      // survived the rename-recreate repairs intact (foreign_keys is
      // suspended for the whole migration, not left enabled mid-rename).
      expect(db.raw.prepare("SELECT id, title FROM work_items WHERE id = 1").get()).toEqual({ id: 1, title: "Legacy work item" });
      expect(db.raw.prepare("SELECT id, work_item_id FROM work_jobs WHERE id = 1").get()).toEqual({ id: 1, work_item_id: 1 });
      expect(db.raw.prepare("SELECT id, work_item_id, job_id FROM approvals WHERE id = 1").get()).toEqual({ id: 1, work_item_id: 1, job_id: 1 });
      expect(db.raw.prepare("SELECT id, pr_number FROM github_links WHERE id = 1").get()).toEqual({ id: 1, pr_number: 147 });
      expect(db.raw.pragma("foreign_keys", { simple: true })).toBe(1);

      // foreign_key_check reports zero violations post-migration — proves
      // the rename-recreate repairs didn't just avoid throwing, but left a
      // referentially sound database.
      expect(db.raw.pragma("foreign_key_check")).toEqual([]);

      // The rebuilt tables' FK clauses target the final table names
      // (work_items, work_jobs), not a leftover *_migrate_tmp reference —
      // proves legacy_alter_table's reference-preservation actually landed
      // on the real target, not a temporary intermediate.
      const workJobsFkSql = (db.raw.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='work_jobs'`
      ).get() as { sql: string }).sql;
      expect(workJobsFkSql).toContain("REFERENCES work_items(id)");
      expect(workJobsFkSql).not.toContain("_migrate_tmp");
      const approvalsFkSql = (db.raw.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='approvals'`
      ).get() as { sql: string }).sql;
      expect(approvalsFkSql).toContain("REFERENCES work_items(id)");
      expect(approvalsFkSql).toContain("REFERENCES work_jobs(id)");
      expect(approvalsFkSql).not.toContain("_migrate_tmp");

      // No migration temp/scratch tables remain.
      const tableNames = (db.raw.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'`
      ).all() as Array<{ name: string }>).map((t) => t.name);
      expect(tableNames.filter((name) => name.includes("_migrate_tmp") || name.includes("_legacy_migration"))).toEqual([]);
      db.close();

      // Reopening an already-current database must not re-run the repair
      // or prompt-retirement paths — user_version is authoritative.
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

it("drops an empty prompts table when migrating a version 1 database", () => {
  const fixture = tempDbPath("prompt-retirement-empty");
  try {
    createLegacyFixture(fixture.path);
    const raw = new Database(fixture.path);
    applyMigrationsUpTo(raw, [
      { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
    ], 1);
    expect(raw.pragma("user_version", { simple: true })).toBe(1);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompts'").get()).toBeTruthy();
    raw.close();

    const migrated = openDb(fixture.path, { serviceId: "schema-test:prompt-retirement" });
    expect(migrated.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompts'").get()).toBeUndefined();
    migrated.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

it("rolls back prompt-table retirement when an unexpected row exists", () => {
  const fixture = tempDbPath("prompt-retirement-populated");
  try {
    createLegacyFixture(fixture.path);
    const raw = new Database(fixture.path);
    applyMigrationsUpTo(raw, [
      { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
    ], 1);
    raw.prepare("INSERT INTO prompts (name, prompt_text) VALUES (?, ?)").run("unexpected", "legacy value");

    expect(() => applyMigrations(raw)).toThrow(LegacyPromptOverridesPresentError);
    expect(raw.pragma("user_version", { simple: true })).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) AS count FROM prompts").get()).toEqual({ count: 1 });
    raw.close();
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

  it("fails closed for a negative schema version without enabling WAL mode", () => {
    const fixture = tempDbPath("negative");
    try {
      const raw = new Database(fixture.path);
      raw.exec("CREATE TABLE sentinel(value TEXT); PRAGMA user_version = -5;");
      raw.close();

      const walPath = `${fixture.path}-wal`;
      const shmPath = `${fixture.path}-shm`;

      expect(() => openDb(fixture.path)).toThrow(/unsupported database schema version -5/i);

      expect(existsSync(walPath)).toBe(false);
      expect(existsSync(shmPath)).toBe(false);

      const verify = new Database(fixture.path, { readonly: true });
      expect(verify.pragma("journal_mode", { simple: true })).toBe("delete");
      expect(verify.pragma("user_version", { simple: true })).toBe(-5);
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
      // The explicit-target helper injects a deliberate failing plan without
      // changing the production migration registry. Production code always calls
      // applyMigrations(), which never accepts
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

  it("rolls back completely when applyLegacyCompatibleBaseline itself fails on a real dangling foreign key", () => {
    // Not a synthetic migration list — this drives the actual production
    // migration entry point (applyMigrations -> applyLegacyCompatibleBaseline)
    // against a legacy fixture carrying a genuine data defect: an orphaned
    // approvals row referencing a work_job that doesn't exist (plausible in
    // a real pre-versioning instance that ran without FK enforcement).
    // Proves the new foreign_key_check gate actually blocks a real repair
    // failure, not just a contrived test migration.
    const fixture = tempDbPath("baseline-failure");
    try {
      createLegacyFixture(fixture.path);
      const raw = new Database(fixture.path);
      raw.pragma("foreign_keys = OFF");
      raw.exec(`
        INSERT INTO approvals (id, work_item_id, job_id, approval_type, status, requested_by)
        VALUES (2, 1, 999, 'merge_pr', 'approved', 'nick');
      `);
      raw.pragma("foreign_keys = ON");

      let caught: unknown;
      try {
        applyMigrations(raw);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MigrationForeignKeyViolationError);
      const violationError = caught as MigrationForeignKeyViolationError;
      expect(violationError.violations).toEqual([
        expect.objectContaining({ table: "approvals", parent: "work_jobs" }),
      ]);

      // Complete rollback on the very connection that ran the failed
      // migration: version marker untouched, no migration temp tables left
      // behind, the pre-existing dangling row (the defect itself) is exactly
      // as it was, and foreign_keys enforcement — suspended for the
      // migration attempt — is restored to its prior value (ON).
      expect(raw.pragma("user_version", { simple: true })).toBe(0);
      expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
      const tableNames = (raw.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'`
      ).all() as Array<{ name: string }>).map((t) => t.name);
      expect(tableNames.filter((name) => name.includes("_migrate_tmp") || name.includes("_legacy_migration"))).toEqual([]);
      expect(raw.prepare("SELECT id, job_id FROM approvals WHERE id = 2").get()).toEqual({ id: 2, job_id: 999 });
      expect(raw.prepare("SELECT id, title FROM work_items WHERE id = 1").get()).toEqual({ id: 1, title: "Legacy work item" });
      raw.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects a production migration plan that does not end exactly at CURRENT_SCHEMA_VERSION", () => {
    const fixture = tempDbPath("overshoot");
    const overshootMigrations: readonly Migration[] = [
      { version: 1, name: "legacy-compatible-baseline", up: () => undefined },
      { version: 2, name: "drop-empty-legacy-prompt-overrides", up: () => undefined },
      { version: 3, name: "add-dormant-role-assignments", up: () => undefined },
      { version: 4, name: "unexpected-extra-step", up: () => undefined },
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
