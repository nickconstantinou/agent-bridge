import type Database from "better-sqlite3";

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

/** Applies migrations in order and commits the version marker with each step. */
export function applyMigrations(
  db: Database.Database,
  migrations: readonly Migration[] = DEFAULT_MIGRATIONS,
): void {
  const current = Number(db.pragma("user_version", { simple: true }));
  if (!Number.isInteger(current) || current < 0 || current > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(current);
  }
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const expected = ordered.map((migration) => migration.version);
  if (expected.some((version, index) => version !== index + 1)) {
    throw new Error("database migrations must be sequentially numbered from 1");
  }
  if (ordered.length < CURRENT_SCHEMA_VERSION) {
    throw new Error(`database migrations stop before current schema version ${CURRENT_SCHEMA_VERSION}`);
  }
  if (current === CURRENT_SCHEMA_VERSION) return;

  const migrate = db.transaction(() => {
    for (const migration of ordered) {
      if (migration.version <= current) continue;
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    }
  });
  migrate();
}

/**
 * Version 1 is the compatibility baseline. Historical repair logic remains in
 * the existing initializer until each repair receives its own migration.
 */
const DEFAULT_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "legacy-compatible-baseline", up: () => undefined },
];
