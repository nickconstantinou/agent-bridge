/**
 * PURPOSE: Retire the empty legacy SQLite prompt-override table.
 * INPUTS: A schema-version-1 Bridge database connection.
 * OUTPUTS: The prompts table is absent, or migration fails without data loss.
 * NEIGHBORS: src/db/schema.ts, src/db/legacyBaselineMigration.ts
 */

import type Database from "better-sqlite3";

export class LegacyPromptOverridesPresentError extends Error {
  constructor(public readonly rowCount: number) {
    super(`cannot retire legacy prompts table: expected 0 rows, found ${rowCount}`);
    this.name = "LegacyPromptOverridesPresentError";
  }
}

export function dropLegacyPromptOverrides(db: Database.Database): void {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prompts'",
  ).get();
  if (!table) return;

  const { rowCount } = db.prepare(
    "SELECT COUNT(*) AS rowCount FROM prompts",
  ).get() as { rowCount: number };
  if (rowCount !== 0) throw new LegacyPromptOverridesPresentError(rowCount);

  db.exec("DROP TABLE prompts");
}
