from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one occurrence, found {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "docs/agentic-maintenance.md",
    "Canonical role prompts are versioned source-controlled files and never consume database prompt text. Existing database rows remain a temporary legacy compatibility input only for handlers that have not yet migrated. They cannot change role, mode, tools, permissions, schema, validator, repair count, lifecycle authority, or human gates; no new role prompt or operator/platform workflow may create them. Legacy prompt keys remain explicit compatibility aliases until the corresponding role path is qualified and its existing rows are inventoried or migrated.",
    "Canonical and compatibility prompts are versioned source-controlled files and never consume database prompt text. The legacy prompt table, accessors, loader override options, and handler reads were removed in schema migration 2. Legacy prompt keys remain explicit source-file compatibility aliases until the corresponding role path is qualified; they cannot change role, mode, tools, permissions, schema, validator, repair count, lifecycle authority, or human gates.",
)

replace_once(
    "docs/testing/agentic-worker-verification.md",
    "### Prompt registry and override isolation",
    "### Prompt registry and source isolation",
)
replace_once(
    "docs/testing/agentic-worker-verification.md",
    "- canonical role prompts ignore database prompt rows and always resolve `source: builtin`;\n- legacy database overrides remain available only to explicitly unmigrated compatibility handlers;\n- legacy override text cannot change role, mode, tools, permissions, budget, validator, repair count, or lifecycle authority;\n- unknown keys and incompatible legacy override inputs fail safely;",
    "- canonical and compatibility prompts resolve only from registered source-controlled files and report `source: builtin`;\n- the database prompt table, accessors, loader override options, and handler reads are absent;\n- schema migration 2 drops an absent or empty legacy table transactionally;\n- an unexpected populated table fails closed and preserves schema version 1 plus its rows for investigation;\n- unknown prompt keys and incompatible contract inputs fail safely;",
)

for old, new in [
    ("source-controlled role/mode prompts, validators, focused repair, red-test planning, and legacy override retirement", "source-controlled role/mode prompts, validators, focused repair, red-test planning, and completed override removal"),
    ("Source-controlled role/mode prompt registry, red-test planning, focused repair, and DB override retirement.", "Source-controlled role/mode prompt registry, red-test planning, focused repair, and completed database-override removal."),
    ("Prompt separation, comprehensive advisor-authored red-test requirements, and DB override retirement.", "Prompt separation, comprehensive advisor-authored red-test requirements, and completed database-override removal."),
    ("Role-based worker guide, prompt contracts, red-test quality, and legacy override retirement.", "Role-based worker guide, prompt contracts, red-test quality, and source-only prompt operation."),
    ("- The SQLite `prompts` table is a deprecated legacy override channel, not a backup or canonical source.", "- Schema migration 2 removes the legacy SQLite `prompts` table; runtime prompts resolve only from reviewed source files."),
]:
    replace_once("docs/README.md", old, new)

replace_once(
    "docs/WORKER-GUIDE.md",
    "### A legacy database prompt row exists\n\nTreat it as deprecated configuration, not a backup. Inventory its key and content hash, identify whether it contains required custom behaviour, and record migrate, discard, or hold. Do not add another row or expose prompt contents in logs.",
    "### Prompt-table migration reports an unexpected row\n\nDo not restart services or bypass the migration. Schema migration 2 fails closed and preserves schema version 1 plus the table contents. Since production rows are expected to be absent, treat this as configuration drift: inspect it through the guarded database process without logging prompt text, resolve the discrepancy explicitly, then rerun the migration. Runtime code has no prompt-table reader or writer.",
)

replace_once(
    "docs/implementation-plans/issue-159-prompt-and-red-test-contract.md",
    "- new database prompt overrides.",
    "- reintroducing database prompt overrides.",
)
