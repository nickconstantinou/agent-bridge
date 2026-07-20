import type Database from "better-sqlite3";

const REVISION_COLUMNS = [
  "id",
  "scope_key",
  "revision",
  "source",
  "status",
  "idempotency_key",
  "created_at",
] as const;
const ASSIGNMENT_COLUMNS = [
  "revision_id",
  "role",
  "selection_mode",
  "primary_cli",
  "primary_model",
  "fallbacks_json",
] as const;
const ROLE_TABLES = ["role_assignment_revisions", "role_assignments"] as const;

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

function assertExactColumns(
  raw: Database.Database,
  table: string,
  expected: readonly string[],
): void {
  const actual = raw.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  if (actual.length !== expected.length || actual.some((column, index) => column.name !== expected[index])) {
    throw new Error(`unexpected ${table} schema: [${actual.map((column) => column.name).join(",")}]`);
  }
  const expectedMeta = table === "role_assignment_revisions"
    ? [["INTEGER", 0, 1], ["TEXT", 1, 0], ["INTEGER", 1, 0], ["TEXT", 1, 0], ["TEXT", 1, 0], ["TEXT", 1, 0], ["TEXT", 1, 0]]
    : [["INTEGER", 1, 1], ["TEXT", 1, 2], ["TEXT", 1, 0], ["TEXT", 1, 0], ["TEXT", 1, 0], ["TEXT", 1, 0]];
  if (actual.some((column, index) => column.type.toUpperCase() !== expectedMeta[index][0]
    || column.notnull !== expectedMeta[index][1] || column.pk !== expectedMeta[index][2])) {
    throw new Error(`unexpected ${table} schema metadata`);
  }
  if (table === "role_assignments" && actual[5].dflt_value !== "'[]'") {
    throw new Error("unexpected role_assignments fallback default");
  }
}

function indexSignatures(raw: Database.Database, table: string): string[] {
  const indexes = raw.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number; origin: string }>;
  return indexes.map((index) => {
    const columns = (raw.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map((row) => row.name);
    return `${index.unique}:${index.origin}:${columns.join(",")}`;
  }).sort();
}

export function assertExactRoleAssignmentSchema(raw: Database.Database): void {
  assertExactColumns(raw, "role_assignment_revisions", REVISION_COLUMNS);
  assertExactColumns(raw, "role_assignments", ASSIGNMENT_COLUMNS);
  const revisionIndexes = indexSignatures(raw, "role_assignment_revisions");
  for (const required of ["0:c:scope_key,revision", "1:u:scope_key,idempotency_key", "1:u:scope_key,revision"]) {
    if (!revisionIndexes.includes(required)) throw new Error(`unexpected role_assignment_revisions indexes: [${revisionIndexes.join(";")}]`);
  }
  const assignmentIndexes = indexSignatures(raw, "role_assignments");
  if (!assignmentIndexes.includes("1:pk:revision_id,role")) {
    throw new Error(`unexpected role_assignments indexes: [${assignmentIndexes.join(";")}]`);
  }
  const foreignKeys = raw.prepare("PRAGMA foreign_key_list(role_assignments)").all() as Array<Record<string, unknown>>;
  if (foreignKeys.length !== 1 || foreignKeys[0].table !== "role_assignment_revisions"
    || foreignKeys[0].from !== "revision_id" || foreignKeys[0].to !== "id"
    || String(foreignKeys[0].on_delete).toUpperCase() !== "CASCADE") {
    throw new Error("unexpected role_assignments foreign key");
  }
  const tableSql = (raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name IN (?, ?) ORDER BY name")
    .all(...ROLE_TABLES) as Array<{ sql: string }>).map((row) => row.sql.toLowerCase().replace(/\s+/g, " ")).join(" ");
  for (const required of ["configured_dormant", "technical_lead", "documentation_steward", "json_valid(fallbacks_json)"]) {
    if (!tableSql.includes(required)) throw new Error(`unexpected role-assignment constraints: missing ${required}`);
  }
}

export function assertDatabaseForeignKeyIntegrity(raw: Database.Database): void {
  const violations = raw.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) throw new Error("database foreign key integrity check failed");
}

/**
 * Schema version 3: additive, dormant Engineering Worker role assignments.
 *
 * The revision row is the append-only policy identity for one scope. Role rows
 * are children of that revision and contain only bounded provider/model
 * identifiers. Routing remains disabled; no current job or handler reads these
 * tables for provider selection.
 */
export function applyRoleAssignmentsMigration(raw: Database.Database): void {
  const preExisting = raw.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name IN (?, ?)
    ORDER BY name
  `).all(...ROLE_TABLES) as Array<{ name: string }>;
  if (preExisting.length > 0) {
    throw new Error(
      `unexpected pre-existing role-assignment tables at schema version 2: ${preExisting.map((row) => row.name).join(",")}`,
    );
  }

  raw.exec(`
    CREATE TABLE role_assignment_revisions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key        TEXT NOT NULL,
      revision         INTEGER NOT NULL,
      source           TEXT NOT NULL CHECK (source IN ('environment', 'operator', 'platform')),
      status           TEXT NOT NULL CHECK (status IN ('configured_dormant')),
      idempotency_key  TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(scope_key, revision),
      UNIQUE(scope_key, idempotency_key)
    );

    CREATE TABLE role_assignments (
      revision_id      INTEGER NOT NULL,
      role             TEXT NOT NULL CHECK (role IN ('technical_lead', 'code_worker', 'documentation_steward')),
      selection_mode   TEXT NOT NULL CHECK (selection_mode IN ('automatic', 'recommended', 'manual')),
      primary_cli      TEXT NOT NULL,
      primary_model    TEXT NOT NULL,
      fallbacks_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fallbacks_json)),
      PRIMARY KEY(revision_id, role),
      FOREIGN KEY(revision_id) REFERENCES role_assignment_revisions(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_role_assignment_revisions_scope_revision
      ON role_assignment_revisions(scope_key, revision DESC);
  `);

  // The assertions execute inside the migration transaction. A defect in the
  // migration DDL leaves user_version and every migration-created object
  // unchanged rather than blessing an incomplete current schema.
  assertExactRoleAssignmentSchema(raw);
}
