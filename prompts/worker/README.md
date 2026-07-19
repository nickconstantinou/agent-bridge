# Worker Prompt Pack

This directory contains the version-controlled prompts used by the Agent Bridge Engineering Worker.

## Prompt families

- `roles/` contains canonical Technical Lead, Code Worker, and Documentation Steward prompts registered in `src/agenticPromptContracts.ts`.
- Files in this directory retain current handler keys while Issue #159 migrates dispatch to role-native keys.
- `supplements/` contains only additional Agent Bridge-specific, phase-specific guidance.
- Canonical reusable software-development lifecycle know-how remains under `skills/` and is composed by `src/lifecycleSkillGuidance.ts`.

## Authority boundary

Prompts and skills guide model behaviour but never grant authority. Agent Bridge code owns role and mode selection, evidence, tools, permissions, budgets, validators, lifecycle state, persistence, approvals, merge, deployment, and destructive-operation gates.

## Resolution

Every prompt resolves from reviewed repository files. There is no database template precedence, mutable prompt override, or runtime fallback text.

The loaders:

1. resolve the registered role or compatibility prompt file;
2. load only the explicitly mapped canonical lifecycle skills;
3. validate each skill manifest and its single marked runtime-guidance block;
4. append additional registered worker supplements only where applicable;
5. bound variables and render the prompt;
6. fail closed on missing files, malformed skill blocks, version drift, duplicates, or budget violations.

Canonical role prompts record stable role-template, skill-set, composed-template, and invocation-specific rendered hashes. Provider fallback changes only the target/model, not the prompt or skill contract.

## Canonical lifecycle skills

The authoritative reusable lifecycle sources are:

- `skills/requirements-to-acceptance/SKILL.md`;
- `skills/risk-based-test-strategy/SKILL.md`;
- `skills/red-green-refactor-tdd/SKILL.md`;
- `skills/release-readiness-review/SKILL.md`.

Each skill exposes one block between `BEGIN AGENT_BRIDGE_RUNTIME_GUIDANCE` and `END AGENT_BRIDGE_RUNTIME_GUIDANCE`. Do not copy those passages into role prompts or compatibility supplements. Update the skill once and let all consuming prompt contracts receive the reviewed change through their explicit mapping.

The former duplicated `supplements/test-driven-development.md` has been removed. TDD guidance now comes only from the canonical `red-green-refactor-tdd` skill.

## Database retirement

Schema migration 2 removes the legacy `prompts` table. Migration succeeds only when the table is absent or empty. An unexpected row aborts transactionally and leaves schema version 1 and the table unchanged for investigation.

`BridgeDb.getPrompt()`, `BridgeDb.setPrompt()`, loader database-template options, and handler override reads have been removed. Prompt rollback is performed by deploying a reviewed application SHA, not by mutable SQLite content.

## Planning and TDD

Technical Lead planning owns comprehensive red-test design. Plans map acceptance criteria, architecture boundaries, invariants, and triggered risks to concrete tests or deterministic proof. Code Worker red/green phases receive the approved execution contract rather than inventing or weakening test intent.

## Maintenance

Prompt or lifecycle-skill changes require a reviewed Git diff, version/contract review when compatibility changes, focused semantic and drift tests, full CI, and a known application-SHA rollback.

See [`WIRING.md`](./WIRING.md) and `docs/architecture/agentic-prompt-contracts.md`.
