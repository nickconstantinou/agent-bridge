import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations, CURRENT_SCHEMA_VERSION, type Migration } from "../src/db/schema.js";
import { openDb } from "../src/db.js";

const ROLE_FIXTURES = ["shared", "discord", "health", "interactive", "worker"] as const;

function tempDbPath(role: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), `agent-bridge-schema-${role}-`));
  return { dir, path: join(dir, "bridge.sqlite") };
}

function createLegacyBaseline(path: string): void {
  // The repository's observed legacy files have the current table shape but
  // no version marker. Create that shape through the compatibility façade,
  // then reset only the marker to model those pre-versioned databases.
  const db = openDb(path);
  db.raw.pragma("user_version = 0");
  db.close();
}

describe("database schema versioning", () => {
  it.each(ROLE_FIXTURES)("migrates the %s legacy database role from user_version 0", (role) => {
    const fixture = tempDbPath(role);
    try {
      createLegacyBaseline(fixture.path);
      const db = openDb(fixture.path, { serviceId: `schema-test:${role}` });
      expect(db.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bridge_state'").get()).toBeTruthy();
      db.close();
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

  it("fails closed for a future schema version without changing the database", () => {
    const fixture = tempDbPath("future");
    try {
      const raw = new Database(fixture.path);
      raw.exec("CREATE TABLE sentinel(value TEXT); PRAGMA user_version = 99;");
      raw.close();

      expect(() => openDb(fixture.path)).toThrow(/unsupported database schema version 99/i);

      const verify = new Database(fixture.path, { readonly: true });
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
      expect(() => applyMigrations(raw, migrations)).toThrow("deliberate migration failure");
      expect(raw.pragma("user_version", { simple: true })).toBe(0);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'probe'").get()).toBeUndefined();
      raw.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
