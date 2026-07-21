import type Database from "better-sqlite3";
import {
  AGENT_ROLE_IDS,
  serializeRoleAssignments,
  type AgentRoleId,
  type RoleAssignment,
  type RoleAssignmentConfig,
  type RoleAssignmentSelection,
  type RoleAssignmentSource,
  type RoleAssignmentStatus,
} from "../agentRoles.js";

export interface RoleAssignmentRevisionRecord {
  id: number;
  scopeKey: string;
  revision: number;
  source: RoleAssignmentSource;
  status: RoleAssignmentStatus;
  idempotencyKey: string;
  createdAt: string;
  assignments: RoleAssignment[];
}

interface RevisionRow {
  id: number;
  scope_key: string;
  revision: number;
  source: RoleAssignmentSource;
  status: RoleAssignmentStatus;
  idempotency_key: string;
  created_at: string;
}

interface AssignmentRow {
  revision_id: number;
  role: AgentRoleId;
  selection_mode: RoleAssignmentSelection;
  primary_cli: string;
  primary_model: string;
  fallbacks_json: string;
}

export class RoleAssignmentIdempotencyConflictError extends Error {
  constructor(_scopeKey: string, _idempotencyKey: string) {
    super("role-assignment idempotency conflict");
    this.name = "RoleAssignmentIdempotencyConflictError";
  }
}

/** Sole SQL owner for dormant role-assignment revisions and child rows. */
export class RoleAssignmentRepository {
  constructor(private readonly db: Database.Database) {}

  createRevision(input: RoleAssignmentConfig): RoleAssignmentRevisionRecord {
    return this.db.transaction(() => {
      const existingRow = this.db.prepare(`
        SELECT id, scope_key, revision, source, status, idempotency_key, created_at
        FROM role_assignment_revisions
        WHERE scope_key = ? AND idempotency_key = ?
      `).get(input.scopeKey, input.idempotencyKey) as RevisionRow | undefined;

      if (existingRow) {
        const existing = this.loadRevision(existingRow);
        if (
          existing.source !== input.source
          || existing.status !== input.status
          || serializeRoleAssignments(existing.assignments) !== serializeRoleAssignments(input.assignments)
        ) {
          throw new RoleAssignmentIdempotencyConflictError(input.scopeKey, input.idempotencyKey);
        }
        return existing;
      }

      const next = this.db.prepare(`
        SELECT COALESCE(MAX(revision), 0) + 1 AS revision
        FROM role_assignment_revisions
        WHERE scope_key = ?
      `).get(input.scopeKey) as { revision: number };

      const inserted = this.db.prepare(`
        INSERT INTO role_assignment_revisions
          (scope_key, revision, source, status, idempotency_key)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        input.scopeKey,
        next.revision,
        input.source,
        input.status,
        input.idempotencyKey,
      );
      const revisionId = Number(inserted.lastInsertRowid);

      const insertAssignment = this.db.prepare(`
        INSERT INTO role_assignments
          (revision_id, role, selection_mode, primary_cli, primary_model, fallbacks_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const assignment of input.assignments) {
        insertAssignment.run(
          revisionId,
          assignment.role,
          assignment.selection,
          assignment.primary.cli,
          assignment.primary.model,
          JSON.stringify(assignment.fallbacks),
        );
      }

      const createdRow = this.db.prepare(`
        SELECT id, scope_key, revision, source, status, idempotency_key, created_at
        FROM role_assignment_revisions
        WHERE id = ?
      `).get(revisionId) as RevisionRow | undefined;
      if (!createdRow) throw new Error("created role-assignment revision could not be read");
      return this.loadRevision(createdRow);
    })();
  }

  getCurrentRevision(scopeKey: string): RoleAssignmentRevisionRecord | null {
    const row = this.db.prepare(`
      SELECT id, scope_key, revision, source, status, idempotency_key, created_at
      FROM role_assignment_revisions
      WHERE scope_key = ?
      ORDER BY revision DESC
      LIMIT 1
    `).get(scopeKey) as RevisionRow | undefined;
    return row ? this.loadRevision(row) : null;
  }

  listRevisions(scopeKey: string): RoleAssignmentRevisionRecord[] {
    const rows = this.db.prepare(`
      SELECT id, scope_key, revision, source, status, idempotency_key, created_at
      FROM role_assignment_revisions
      WHERE scope_key = ?
      ORDER BY revision ASC
    `).all(scopeKey) as RevisionRow[];
    return rows.map((row) => this.loadRevision(row));
  }

  private loadRevision(row: RevisionRow): RoleAssignmentRevisionRecord {
    const rows = this.db.prepare(`
      SELECT revision_id, role, selection_mode, primary_cli, primary_model, fallbacks_json
      FROM role_assignments
      WHERE revision_id = ?
    `).all(row.id) as AssignmentRow[];
    const byRole = new Map(rows.map((assignment) => [assignment.role, assignment]));
    const assignments = AGENT_ROLE_IDS.map((role) => {
      const assignment = byRole.get(role);
      if (!assignment) {
        throw new Error(`role-assignment revision ${row.id} is missing role ${role}`);
      }
      const fallbacks = JSON.parse(assignment.fallbacks_json) as unknown;
      if (!Array.isArray(fallbacks)) {
        throw new Error(`role-assignment revision ${row.id} has invalid fallback data`);
      }
      return {
        role,
        selection: assignment.selection_mode,
        primary: {
          cli: assignment.primary_cli,
          model: assignment.primary_model,
        },
        fallbacks: fallbacks.map((fallback) => {
          if (
            typeof fallback !== "object"
            || fallback === null
            || typeof (fallback as Record<string, unknown>).cli !== "string"
            || typeof (fallback as Record<string, unknown>).model !== "string"
          ) {
            throw new Error(`role-assignment revision ${row.id} has invalid fallback target data`);
          }
          return {
            cli: (fallback as Record<string, string>).cli,
            model: (fallback as Record<string, string>).model,
          };
        }),
      } satisfies RoleAssignment;
    });

    if (rows.length !== AGENT_ROLE_IDS.length) {
      throw new Error(`role-assignment revision ${row.id} has unexpected role rows`);
    }

    return {
      id: row.id,
      scopeKey: row.scope_key,
      revision: row.revision,
      source: row.source,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      assignments,
    };
  }
}
