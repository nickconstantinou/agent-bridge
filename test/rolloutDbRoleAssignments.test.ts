import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyLegacyCompatibleBaseline } from "../src/db/legacyBaselineMigration.js";
import { dropLegacyPromptOverrides } from "../src/db/dropLegacyPromptOverridesMigration.js";
import { applyMigrationsUpTo } from "../src/db/schema.js";

const migrationScript = fileURLToPath(new URL("../scripts/rollout-db.ts", import.meta.url));
const roots: string[] = [];

function createVersion2Database(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-rollout-role-"));
  roots.push(root);
  const path = join(root, "bridge.sqlite");
  const raw = new Database(path);
  applyMigrationsUpTo(raw, [
    { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
    { version: 2, name: "drop-empty-legacy-prompt-overrides", up: dropLegacyPromptOverrides },
  ], 2);
  raw.close();
  return path;
}

function runRolloutDb(mode: "inspect" | "migrate" | "validate", path: string): {
  databases: Array<{ schemaVersion: number; schema: string; tables: string[] }>;
} {
  const stdout = execFileSync(process.execPath, [
    "--import",
    "tsx",
    migrationScript,
    mode,
    "--db",
    path,
    "--evidence",
    "-",
  ], { encoding: "utf8" });
  return JSON.parse(stdout) as {
    databases: Array<{ schemaVersion: number; schema: string; tables: string[] }>;
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("schema 3 rollout qualification", () => {
  it("classifies exact schema 2 as migratable, then validates schema 3 with both dormant role tables", () => {
    const path = createVersion2Database();

    const before = runRolloutDb("inspect", path).databases[0];
    expect(before).toMatchObject({ schemaVersion: 2, schema: "migratable" });
    expect(before.tables).not.toContain("role_assignment_revisions");
    expect(before.tables).not.toContain("role_assignments");

    const migrated = runRolloutDb("migrate", path).databases[0];
    expect(migrated).toMatchObject({ schemaVersion: 3, schema: "current" });
    expect(migrated.tables).toEqual(expect.arrayContaining([
      "role_assignment_revisions",
      "role_assignments",
    ]));

    const validated = runRolloutDb("validate", path).databases[0];
    expect(validated).toMatchObject({ schemaVersion: 3, schema: "current" });
  });
});
