from pathlib import Path
import re
import textwrap


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one occurrence, found {count}: {old[:100]!r}")
    write(path, text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str, *, flags: int = 0) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex match, found {count}: {pattern}")
    write(path, updated)


# BridgeDb no longer exposes mutable prompt storage.
regex_once(
    "src/db.ts",
    r'''\n  getPrompt\(name: string, fallback: string\): string \{.*?\n  \}\n\n  setPrompt\(name: string, promptText: string\): void \{.*?\n  \}\n''',
    "\n",
    flags=re.DOTALL,
)

# Fresh databases never create the retired table.
regex_once(
    "src/db/legacyBaselineMigration.ts",
    r'''\n    CREATE TABLE IF NOT EXISTS prompts \(.*?\n    \);\n(?=    CREATE TABLE IF NOT EXISTS advisor_calls)''',
    "\n",
    flags=re.DOTALL,
)

write(
    "src/db/dropLegacyPromptOverridesMigration.ts",
    textwrap.dedent('''\
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
    '''),
)

# Register transactional schema migration 2.
replace_once(
    "src/db/schema.ts",
    'import { applyLegacyCompatibleBaseline } from "./legacyBaselineMigration.js";\n',
    'import { applyLegacyCompatibleBaseline } from "./legacyBaselineMigration.js";\nimport { dropLegacyPromptOverrides } from "./dropLegacyPromptOverridesMigration.js";\n',
)
replace_once("src/db/schema.ts", "export const CURRENT_SCHEMA_VERSION = 1;", "export const CURRENT_SCHEMA_VERSION = 2;")
replace_once(
    "src/db/schema.ts",
    '''const DEFAULT_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
];''',
    '''const DEFAULT_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
  { version: 2, name: "drop-empty-legacy-prompt-overrides", up: dropLegacyPromptOverrides },
];''',
)

# Handler prompt reads now resolve only from source-controlled files.
handler_expected = {
    "src/handlers/featurePlan.ts": 1,
    "src/handlers/defectScan.ts": 3,
    "src/handlers/refactorScan.ts": 2,
    "src/handlers/orchestratedTask.ts": 2,
    "src/handlers/implementationPlan.ts": 3,
}
for path, expected in handler_expected.items():
    text = read(path)
    text, count = re.subn(r'\n\s*\{ dbTemplate: ctx\.db\.getPrompt\([^\n]+\) \},', '', text)
    if count != expected:
        raise RuntimeError(f"{path}: expected {expected} DB prompt reads, removed {count}")
    write(path, text)

helper_replacements = {
    "src/handlers/defectScan.ts": [
        ("async function buildScanPrompt(ctx: JobHandlerContext,", "async function buildScanPrompt("),
        ("async function buildPlanPrompt(ctx: JobHandlerContext,", "async function buildPlanPrompt("),
        ("async function buildTriagePrompt(\n  ctx: JobHandlerContext,\n  repository:", "async function buildTriagePrompt(\n  repository:"),
        ("buildScanPrompt(ctx,", "buildScanPrompt("),
        ("buildPlanPrompt(ctx,", "buildPlanPrompt("),
        ("buildTriagePrompt(ctx,", "buildTriagePrompt("),
    ],
    "src/handlers/refactorScan.ts": [
        ("async function buildScanPrompt(ctx: JobHandlerContext,", "async function buildScanPrompt("),
        ("async function buildPlanPrompt(ctx: JobHandlerContext,", "async function buildPlanPrompt("),
        ("buildScanPrompt(ctx,", "buildScanPrompt("),
        ("buildPlanPrompt(ctx,", "buildPlanPrompt("),
    ],
    "src/handlers/orchestratedTask.ts": [
        ("async function buildPlanPrompt(ctx: JobHandlerContext,", "async function buildPlanPrompt("),
        ("async function buildExecutePrompt(ctx: JobHandlerContext,", "async function buildExecutePrompt("),
        ("buildPlanPrompt(ctx,", "buildPlanPrompt("),
        ("buildExecutePrompt(ctx,", "buildExecutePrompt("),
    ],
    "src/handlers/implementationPlan.ts": [
        ("async function buildCreatePrompt(ctx: JobHandlerContext,", "async function buildCreatePrompt("),
        ("async function buildImprovePrompt(ctx: JobHandlerContext,", "async function buildImprovePrompt("),
        ("async function buildContractRepairPrompt(ctx: JobHandlerContext,", "async function buildContractRepairPrompt("),
        ("buildCreatePrompt(ctx,", "buildCreatePrompt("),
        ("buildImprovePrompt(ctx,", "buildImprovePrompt("),
        ("buildContractRepairPrompt(ctx,", "buildContractRepairPrompt("),
    ],
}
for path, replacements in helper_replacements.items():
    text = read(path)
    for old, new in replacements:
        if old not in text:
            raise RuntimeError(f"{path}: missing helper replacement {old!r}")
        text = text.replace(old, new)
    write(path, text)

regex_once(
    "src/handlers/tddImplementation.ts",
    r'''async function loadTddPrompt\(\n  ctx: JobHandlerContext,\n  key: WorkerPromptKey,\n  variables: Record<string, unknown>,\n\): Promise<string> \{\n  return loadWorkerPrompt\(key, variables, promptReader, \{\n    dbTemplate: ctx\.db\.getPrompt\(key, ""\),\n  \}\);\n\}''',
    '''async function loadTddPrompt(
  key: WorkerPromptKey,
  variables: Record<string, unknown>,
): Promise<string> {
  return loadWorkerPrompt(key, variables, promptReader);
}''',
)
text = read("src/handlers/tddImplementation.ts")
text, count = re.subn(r"loadTddPrompt\(ctx,\s*", "loadTddPrompt(", text)
if count != 4:
    raise RuntimeError(f"tddImplementation: expected four prompt calls, updated {count}")
write("src/handlers/tddImplementation.ts", text)

# Remove the loader override API and obsolete DB-key metadata.
regex_once(
    "src/workerPrompts.ts",
    r'''  /\*\* Existing or future DB prompt override key\. \*/\n  dbKey: WorkerPromptKey;\n''',
    "",
)
text = read("src/workerPrompts.ts")
text, count = re.subn(r'^\s{4}dbKey: "[^"]+",\n', '', text, flags=re.MULTILINE)
if count != 15:
    raise RuntimeError(f"workerPrompts: expected 15 dbKey fields, removed {count}")
write("src/workerPrompts.ts", text)
regex_once(
    "src/workerPrompts.ts",
    r'''  /\*\* Optional DB template\. When provided, it wins over the bundled prompt file\. \*/\n  dbTemplate\?: string \| null;\n  /\*\* Allows tests or future callers to suppress supplement injection\. \*/\n  includeSupplements\?: boolean;\n  /\*\* DB overrides are assumed complete by default; opt in only if an override needs bundled supplements\. \*/\n  includeSupplementsForDbTemplate\?: boolean;\n''',
    '''  /** Allows tests or callers to suppress supplement injection. */
  includeSupplements?: boolean;
''',
)
regex_once(
    "src/workerPrompts.ts",
    r'''  const definition = WORKER_PROMPTS\[key\];\n  const usingDbTemplate = Boolean\(options\.dbTemplate\?\.trim\(\)\);\n  const baseTemplate = usingDbTemplate\n    \? String\(options\.dbTemplate\)\n    : await reader\.readText\(definition\.filePath\);\n\n  const limitedVariables = limitWorkerPromptVariables\(key, variables, options\.variableLimits\);\n  const renderedBase = renderWorkerPrompt\(baseTemplate, limitedVariables\);\n\n  const shouldAppendSupplements = options\.includeSupplements !== false &&\n    \(!usingDbTemplate \|\| options\.includeSupplementsForDbTemplate === true\);\n\n  if \(!shouldAppendSupplements\) \{''',
    '''  const definition = WORKER_PROMPTS[key];
  const baseTemplate = await reader.readText(definition.filePath);

  const limitedVariables = limitWorkerPromptVariables(key, variables, options.variableLimits);
  const renderedBase = renderWorkerPrompt(baseTemplate, limitedVariables);

  if (options.includeSupplements === false) {''',
)

# Loader tests prove source-only resolution and supplements.
regex_once(
    "test/workerPromptLoader.test.ts",
    r'''\n  it\("uses an override without extras by default".*?\n  \}\);\n\n  it\("can append extras to an override when requested".*?\n  \}\);\n''',
    '''
  it("appends registered supplements to a bundled template", async () => {
    const prompt = await loadWorkerPrompt("feature_plan", { value: "abc" }, reader);

    expect(prompt).toContain("Feature abc");
    expect(prompt).toContain("Supplement text");
  });
''',
    flags=re.DOTALL,
)
text = read("test/handlers/refactorScan.test.ts")
text, count = re.subn(r'^\s*getPrompt: vi\.fn\(\)\.mockImplementation\(\(name, fallback\) => fallback\),\n', '', text, flags=re.MULTILINE)
if count != 1:
    raise RuntimeError(f"refactorScan test: expected one getPrompt mock, removed {count}")
write("test/handlers/refactorScan.test.ts", text)

# Migration tests cover v0/v1 success and populated-table rollback.
replace_once(
    "test/dbSchema.test.ts",
    'import { applyMigrations, applyMigrationsUpTo, CURRENT_SCHEMA_VERSION, MigrationForeignKeyViolationError, type Migration } from "../src/db/schema.js";\n',
    'import { applyMigrations, applyMigrationsUpTo, CURRENT_SCHEMA_VERSION, MigrationForeignKeyViolationError, type Migration } from "../src/db/schema.js";\nimport { applyLegacyCompatibleBaseline } from "../src/db/legacyBaselineMigration.js";\nimport { LegacyPromptOverridesPresentError } from "../src/db/dropLegacyPromptOverridesMigration.js";\n',
)
replace_once(
    "test/dbSchema.test.ts",
    '''      for (const table of ["conversation_turns", "pending_messages", "conversation_summaries", "compaction_attempts", "project_memories"]) {
        expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeTruthy();
      }
''',
    '''      for (const table of ["conversation_turns", "pending_messages", "conversation_summaries", "compaction_attempts", "project_memories"]) {
        expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeTruthy();
      }
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompts'").get()).toBeUndefined();
''',
)
replace_once(
    "test/dbSchema.test.ts",
    "// Reopening an already-migrated (version 1) database must not re-run\n      // the repair path — user_version is authoritative once at 1.",
    "// Reopening an already-current database must not re-run the repair\n      // or prompt-retirement paths — user_version is authoritative.",
)
replace_once(
    "test/dbSchema.test.ts",
    "// two-step scenario intentionally exceeds CURRENT_SCHEMA_VERSION (1).\n      // Production code always calls applyMigrations(), which never accepts",
    "// The explicit-target helper injects a deliberate failing plan without\n      // changing the production migration registry. Production code always calls\n      // applyMigrations(), which never accepts",
)
replace_once(
    "test/dbSchema.test.ts",
    '''    const overshootMigrations: readonly Migration[] = [
      { version: 1, name: "legacy-compatible-baseline", up: () => undefined },
      { version: 2, name: "unexpected-extra-step", up: () => undefined },
    ];''',
    '''    const overshootMigrations: readonly Migration[] = [
      { version: 1, name: "legacy-compatible-baseline", up: () => undefined },
      { version: 2, name: "drop-empty-legacy-prompt-overrides", up: () => undefined },
      { version: 3, name: "unexpected-extra-step", up: () => undefined },
    ];''',
)

migration_tests = textwrap.dedent('''\
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

''')
replace_once(
    "test/dbSchema.test.ts",
    '  it("fails closed for a future schema version without changing the database, WAL mode, or sidecar files", () => {',
    migration_tests + '  it("fails closed for a future schema version without changing the database, WAL mode, or sidecar files", () => {',
)

# Prompt documentation is source-only and records completed retirement.
write("prompts/worker/README.md", textwrap.dedent('''\
# Worker Prompt Pack

This directory contains the version-controlled prompts used by the Agent Bridge Engineering Worker.

## Prompt families

- `roles/` contains canonical Technical Lead, Code Worker, and Documentation Steward prompts registered in `src/agenticPromptContracts.ts`.
- Files in this directory retain current handler keys while Issue #159 migrates dispatch to role-native keys.
- `supplements/` contains compact phase-specific guidance appended only by the registered source-controlled prompt definition.

## Authority boundary

Prompts guide model behaviour but never grant authority. Agent Bridge code owns role and mode selection, evidence, tools, permissions, budgets, validators, lifecycle state, persistence, approvals, merge, deployment, and destructive-operation gates.

## Resolution

Every prompt resolves from its reviewed repository file. There is no database template precedence, mutable prompt override, or runtime fallback text.

The loader resolves the registered file, bounds variables, renders the source template, appends only registered supplements, and fails closed on unreadable files or invalid required context. Canonical role prompts additionally record stable template and invocation-specific rendered hashes. Provider fallback changes only the target/model, not the prompt contract.

## Database retirement

Schema migration 2 removes the legacy `prompts` table. Migration succeeds only when the table is absent or empty. An unexpected row aborts transactionally and leaves schema version 1 and the table unchanged for investigation.

`BridgeDb.getPrompt()`, `BridgeDb.setPrompt()`, loader database-template options, and handler override reads have been removed. Prompt rollback is performed by deploying a reviewed application SHA, not by mutable SQLite content.

## Planning and TDD

Technical Lead planning owns comprehensive red-test design. Plans map acceptance criteria, architecture boundaries, invariants, and triggered risks to concrete tests or deterministic proof. Code Worker red/green phases receive the approved execution contract rather than inventing or weakening test intent.

## Maintenance

Prompt changes require a reviewed Git diff, contract/version review when compatibility changes, focused semantic tests, full CI, and a known application-SHA rollback.

See [`WIRING.md`](./WIRING.md) and `docs/architecture/agentic-prompt-contracts.md`.
'''))

write("prompts/worker/WIRING.md", textwrap.dedent('''\
# Worker Prompt Wiring Guide

## Status

Worker prompts are source-controlled only. The former SQLite override path and loader override API are removed by PR #160.

## Core rules

- Resolve every prompt through `loadWorkerPrompt(...)` or `loadAgenticPrompt(...)` using its registered repository file.
- Do not add runtime prompt text, database overrides, operator-editable prompt fields, or hardcoded emergency prompt fallbacks.
- Keep full plans for approval/audit surfaces and pass compact execution contracts to red, green, CI-fix, and repair phases.
- Keep permissions, validators, budgets, lifecycle transitions, retries, merge, and deployment controls outside prompt text.
- Missing files, invalid required context, malformed structured output, or failed budget checks fail closed.

## Current handler map

| Handler | Prompt key | Primary variables |
|---|---|---|
| `featurePlan.ts` | `feature_plan` | `repository`, `brief` |
| `implementationPlan.ts` | `implementation_plan:create` | `repository`, `kind`, `source`, `title`, `body` |
| `implementationPlan.ts` | `implementation_plan:improve` | `missing`, `planText` |
| `implementationPlan.ts` | `implementation_plan:contract_repair` | `planText` |
| `defectScan.ts` | `defect_scan:scan` / `plan` / `triage` | repository and bounded finding evidence |
| `refactorScan.ts` | `refactor_scan:scan` / `plan` | repository and bounded finding evidence |
| `tddImplementation.ts` | `tdd_implementation:*` | approved execution contract and bounded plan/failure context |
| `orchestratedTask.ts` | `orchestrated_task:plan` / `execute` | issue or compact execution context |

Compatibility keys still map to source-controlled files. Role-native routing must preserve the same source-only rule.

## Plan wiring

1. Load the create prompt from its registered file.
2. Generate and validate the complete Markdown plan.
3. Require structured `Red Tests`, `Red Test Coverage`, and `Execution Contract` sections.
4. Use full-plan improvement once when multiple sections are invalid.
5. Use a dedicated focused repair prompt only when one section is invalid.
6. Revalidate the complete plan before persistence or approval.

## Execution wiring

- Red mode receives approved red-test records and may change tests only.
- Green mode receives committed red evidence and may not alter red tests.
- CI-fix and repair receive bounded failure context and remain inside the approved packet.
- Verify mode returns evidence without introducing source changes.

## Schema migration 2

The guarded rollout helper upgrades schema version 1 databases to version 2. Migration 2 treats an absent table as retired, drops an empty `prompts` table transactionally, rejects a populated table without logging contents, and leaves `user_version = 1` and the table intact on rejection.

Production services using `openProductionDb()` must not restart on version 1 databases before guarded migration completes.

## Required verification

Run prompt loader/contract tests, handler wiring tests, version 0 and version 1 migration tests, the populated-table rollback test, the full suite, typecheck, Architecture Lint, `git diff --check`, and exact-head GitHub Actions.
'''))

# Canonical architecture now records completed retirement.
path = "docs/architecture/agentic-prompt-contracts.md"
text = read(path)
start = text.index("## Prompt storage decision")
end = text.index("## Compatibility", start)
replacement = textwrap.dedent('''\
## Prompt storage decision

Prompt text is a reviewed source artifact. The SQLite `prompts` table and its runtime override API have been removed.

Mutable prompt overrides conflicted with the role architecture because they could change consequential instructions without a reviewed Git diff, contract/version review, exact-head CI, deterministic tests, reproducible workspace content, or rollback to a known application SHA.

Canonical and compatibility prompts therefore resolve only from registered repository files. `AgenticPromptContract.allowDatabaseOverride` is always `false`; `loadAgenticPrompt()` and `loadWorkerPrompt()` have no database-template input.

## Legacy override retirement

Retirement is complete in PR #160:

1. the owner confirmed every production table has zero rows and revised source prompts replace the legacy path;
2. all handler reads and `BridgeDb.getPrompt()` / `setPrompt()` were removed;
3. loader database-template options and obsolete database-key metadata were removed;
4. migration 2 drops an absent or empty table transactionally;
5. an unexpected populated table fails closed, rolls back, and preserves schema version 1 for investigation;
6. fresh databases never create the table.

Prompt rollback is application rollback to a reviewed SHA. No platform, operator, or runtime surface may reintroduce mutable prompt text.

''')
write(path, text[:start] + replacement + text[end:])

# Schema/data documentation.
path = "docs/architecture/01-current-architecture.md"
text = read(path)
text = text.replace(
    "`CURRENT_SCHEMA_VERSION` is `1`; existing `user_version = 0` files are the legacy baseline, future versions fail closed, and `applyMigrationsUpTo()` applies numbered migrations transactionally, verifying `PRAGMA foreign_key_check` before commit.",
    "`CURRENT_SCHEMA_VERSION` is `2`; migration 1 establishes the legacy-compatible baseline and migration 2 removes the empty legacy prompt-override table. Future versions fail closed, and `applyMigrationsUpTo()` applies numbered migrations transactionally, verifying `PRAGMA foreign_key_check` before commit.",
)
text = text.replace(
    "- `src/db/legacyBaselineMigration.ts` — migration 1: owns the full legacy DDL and every historical shape-detected repair, applied once and transactionally. `user_version` is authoritative once a database reaches 1 — repairs no longer re-run on every open.",
    "- `src/db/legacyBaselineMigration.ts` — migration 1: owns the legacy-compatible DDL and historical shape-detected repairs.\n- `src/db/dropLegacyPromptOverridesMigration.ts` — migration 2: removes the absent/empty legacy `prompts` table and fails closed if an unexpected row exists.",
)
text = text.replace(", `prompts`, `conversation_turns`", ", `conversation_turns`")
write(path, text)

path = "docs/architecture/07-data-and-event-model.md"
text = read(path)
first = "SQLite `PRAGMA user_version` is the authoritative schema marker. `user_version = 0` denotes the pre-versioned legacy baseline. Phase 4A establishes `CURRENT_SCHEMA_VERSION = 1`. Migration 1 (`applyLegacyCompatibleBaseline` in `src/db/legacyBaselineMigration.ts`) owns the full legacy DDL and every historical shape-detected repair, applied once, transactionally, advancing legacy databases straight to version 1. `openDb()` version-gates before WAL mode or any write — future, negative, or non-integer versions fail closed and the connection is closed before rethrowing. The migration runner (`applyMigrationsUpTo` in `src/db/schema.ts`) suspends `foreign_keys` enforcement around the whole migration transaction (a documented no-op if toggled inside one), verifies `PRAGMA foreign_key_check` reports zero violations before the transaction can commit, and rolls back both DDL and the version marker — with `foreign_keys` restored — on any failure, including a foreign-key violation."
first_new = "SQLite `PRAGMA user_version` is the authoritative schema marker. `user_version = 0` denotes the pre-versioned legacy baseline and `CURRENT_SCHEMA_VERSION = 2`. Migration 1 (`applyLegacyCompatibleBaseline`) owns the legacy-compatible DDL and historical repairs. Migration 2 (`dropLegacyPromptOverrides`) removes the absent or empty legacy `prompts` table and aborts without data loss if any unexpected row exists. `openDb()` version-gates before WAL mode or any write; the migration runner applies numbered migrations transactionally, verifies `PRAGMA foreign_key_check`, and rolls back both DDL and the version marker on failure."
if first not in text:
    raise RuntimeError("data model: missing schema boundary paragraph")
text = text.replace(first, first_new)
text = text.replace(
    "The five guarded rollout database roles (shared, Discord, health, interactive, and worker) use the same schema contract. `scripts/rollout-db.ts` reports version 0 explicitly as `legacy`, accepts only version 1 as current, and rejects future versions. Historical repair logic now lives entirely in `src/db/legacyBaselineMigration.ts` as migration 1, not in `src/db.ts`; `user_version` is authoritative once a database reaches 1, so repairs no longer re-run on every open.",
    "The five guarded rollout database roles (shared, Discord, health, interactive, and worker) use the same schema contract. `scripts/rollout-db.ts` reports version 0 as `legacy`, versions below 2 as migratable, accepts only version 2 as current, and rejects future versions. Historical repair logic remains in migration 1; prompt override retirement is migration 2; `user_version` is authoritative, so completed migrations do not re-run on open.",
)
text = text.replace("| prompts | settingsRepository | prompt/skill overrides |\n", "")
text = text.replace("| 2+ | future PRs | Individual historical repairs and additive schema changes |", "| 2 | PR #160 | Remove the empty legacy prompt-override table |\n| 3+ | future PRs | Further additive or explicitly approved schema changes |")
write(path, text)

path = "docs/roadmap/issue-135-phase4c-migration-ownership.md"
text = read(path)
text = text.replace(
    "Creates the file (`new Database(dbPath)`'s default mode), applies migration 1's full DDL, ends at `CURRENT_SCHEMA_VERSION`",
    "Creates the file (`new Database(dbPath)`'s default mode), applies the complete registered migration plan, and ends at `CURRENT_SCHEMA_VERSION`",
)
write(path, text)

path = "docs/roadmap/issue-159-role-based-orchestration.md"
text = read(path)
text = text.replace("- staged retirement of legacy database prompt overrides.", "- completed removal of legacy database prompt overrides and their schema table.")
text = text.replace("legacy database prompt overrides are safely retired", "legacy database prompt overrides remain absent")
write(path, text)

path = "docs/implementation-plans/issue-159-prompt-and-red-test-contract.md"
text = read(path)
text = text.replace(
    "6. Remove `setPrompt`, then `getPrompt`, after callers are gone.",
    "6. Completed in PR #160: remove `setPrompt`, `getPrompt`, loader override options, all callers, and the empty table through migration 2.",
)
write(path, text)
