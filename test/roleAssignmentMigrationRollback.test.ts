import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { applyLegacyCompatibleBaseline } from "../src/db/legacyBaselineMigration.js";
import { dropLegacyPromptOverrides } from "../src/db/dropLegacyPromptOverridesMigration.js";
import { applyMigrationsUpTo } from "../src/db/schema.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("role assignment migration rollback", () => {
  it("leaves schema version 2 and pre-existing data unchanged when a role table already exists", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-role-migration-rollback-"));
    roots.push(root);
    const path = join(root, "bridge.sqlite");
    const raw = new Database(path);
    applyMigrationsUpTo(raw, [
      { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
      { version: 2, name: "drop-empty-legacy-prompt-overrides", up: dropLegacyPromptOverrides },
    ], 2);
    raw.exec(`
      INSERT INTO work_items
        (id, kind, source, title, status, priority, created_by)
      VALUES
        (77, 'feature', 'telegram', 'migration sentinel', 'in_progress', 'high', 'operator');

      CREATE TABLE role_assignment_revisions (
        id INTEGER PRIMARY KEY,
        unexpected_column TEXT NOT NULL
      );
      INSERT INTO role_assignment_revisions (id, unexpected_column)
      VALUES (9, 'preserve-me');
    `);
    raw.close();

    expect(() => openDb(path, { serviceId: "role-migration-rollback-test" }))
      .toThrow(/unexpected pre-existing role-assignment tables at schema version 2/i);

    const verify = new Database(path, { readonly: true });
    expect(verify.pragma("user_version", { simple: true })).toBe(2);
    expect(verify.prepare("SELECT id, title FROM work_items WHERE id = 77").get())
      .toEqual({ id: 77, title: "migration sentinel" });
    expect(verify.prepare("SELECT id, unexpected_column FROM role_assignment_revisions").all())
      .toEqual([{ id: 9, unexpected_column: "preserve-me" }]);
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_assignments'").get())
      .toBeUndefined();
    verify.close();
  });
});
