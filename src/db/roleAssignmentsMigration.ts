import type Database from "better-sqlite3";

/**
 * Schema version 3: additive, dormant Engineering Worker role assignments.
 *
 * The revision row is the append-only policy identity for one scope. Role rows
 * are children of that revision and contain only bounded provider/model
 * identifiers. Routing remains disabled; no current job or handler reads these
 * tables for provider selection.
 */
export function applyRoleAssignmentsMigration(raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS role_assignment_revisions (
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

    CREATE TABLE IF NOT EXISTS role_assignments (
      revision_id      INTEGER NOT NULL,
      role             TEXT NOT NULL CHECK (role IN ('technical_lead', 'code_worker', 'documentation_steward')),
      selection_mode   TEXT NOT NULL CHECK (selection_mode IN ('automatic', 'recommended', 'manual')),
      primary_cli      TEXT NOT NULL,
      primary_model    TEXT NOT NULL,
      fallbacks_json   TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY(revision_id, role),
      FOREIGN KEY(revision_id) REFERENCES role_assignment_revisions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_role_assignment_revisions_scope_revision
      ON role_assignment_revisions(scope_key, revision DESC);
  `);
}
