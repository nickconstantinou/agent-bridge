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
