import type Database from "better-sqlite3";
import { applyLegacyCompatibleBaseline } from "./legacyBaselineMigration.js";

/** The schema version written after the legacy-compatible baseline is applied. */
export const CURRENT_SCHEMA_VERSION = 1;

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(version: number) {
    super(`unsupported database schema version ${version}`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

/**
 * Applies migrations transactionally up to an explicit target version. The
 * registered plan must end exactly at targetVersion, and no migration above
 * targetVersion is ever executed. Exported so tests can exercise an
 * intermediate target (e.g. a two-step failure partway through a plan)
 * without weakening the production entry point below.
 */
export function applyMigrationsUpTo(
  db: Database.Database,
  migrations: readonly Migration[],
  targetVersion: number,
): void {
  const current = Number(db.pragma("user_version", { simple: true }));
  if (!Number.isInteger(current) || current < 0 || current > targetVersion) {
    throw new UnsupportedSchemaVersionError(current);
  }
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const expected = ordered.map((migration) => migration.version);
  if (expected.some((version, index) => version !== index + 1)) {
    throw new Error("database migrations must be sequentially numbered from 1");
  }
  const highestRegistered = ordered.length > 0 ? ordered[ordered.length - 1].version : 0;
  if (highestRegistered !== targetVersion) {
    throw new Error(`database migrations must end exactly at target schema version ${targetVersion}`);
  }
  if (current === targetVersion) return;

  const migrate = db.transaction(() => {
    for (const migration of ordered) {
      if (migration.version <= current || migration.version > targetVersion) continue;
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    }
  });
  migrate();
}

/**
 * Production entry point: applies the default migration set, always ending
 * exactly at CURRENT_SCHEMA_VERSION. Never accepts an override target, so a
 * migration plan that overshoots or undershoots the declared version fails
 * closed rather than silently advancing past it.
 */
export function applyMigrations(
  db: Database.Database,
  migrations: readonly Migration[] = DEFAULT_MIGRATIONS,
): void {
  applyMigrationsUpTo(db, migrations, CURRENT_SCHEMA_VERSION);
}

/**
 * Version 1 is the compatibility baseline: it owns the full legacy DDL and
 * historical repair path, transactionally, so user_version is authoritative
 * once a database reaches 1 (no more shape-detected repairs on every open).
 */
const DEFAULT_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
];
