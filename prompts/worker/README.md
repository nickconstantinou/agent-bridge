# Worker Prompt Pack

This directory contains the version-controlled prompts for the Agent Bridge Engineering Worker.

There are two explicit prompt generations:

1. **Canonical role prompts** under `roles/`, registered by `src/agenticPromptContracts.ts`.
2. **Legacy handler prompts** in this directory, registered by `src/workerPrompts.ts`, retained while Issue #159 migrates existing worker phases.

For the handler-by-handler map and migration rules, see [`WIRING.md`](./WIRING.md). The architecture contract is `docs/architecture/agentic-prompt-contracts.md`.

## Authority boundary

Prompts guide model behaviour but never grant authority. Agent Bridge code owns:

- role and mode;
- evidence and context selection;
- tools and permissions;
- budgets and timeouts;
- structured output schemas and validators;
- repair limits;
- workflow state and persistence;
- approvals, merge, deployment, and destructive-operation gates.

A prompt cannot weaken these controls. Existing mechanical invariants remain authoritative:

- no live-checkout implementation mutation;
- no merge without explicit approval;
- red tests must fail for the planned reason before implementation;
- red commits contain test changes only;
- green commits do not alter committed red tests;
- test-only imports do not leak into production code;
- merge verifies the expected PR head and green CI;
- cancellation, retries, leases, PR caps, and stale handling remain code-controlled.

## Canonical prompt resolution

Canonical role prompts resolve only from reviewed source-controlled files:

1. registered prompt key and contract version;
2. source file under `prompts/worker/roles/`;
3. declared required render variables;
4. bounded context rendering;
5. stable source-template hash plus invocation-specific rendered-content hash.

Canonical role contracts set `allowDatabaseOverride: false`. A row in SQLite is not a backup and cannot replace a canonical prompt. Git history, reviewed release artifacts, and the recorded application SHA provide reproducible prompt rollback.

Missing required variables, unknown keys, invalid contract versions, unreadable source files, or oversized rendered output fail closed. Fallback models receive the same key, version, source template, schema, validator, tools, and permissions; only the target/model changes.

## Legacy database overrides

Some existing handlers still call `ctx.db.getPrompt(...)`. Those rows are mutable legacy runtime overrides, not the canonical source and not a disaster-recovery backup.

During migration:

- no new role prompt or platform/operator workflow may create a database override;
- existing rows remain usable only by explicitly unmigrated legacy handlers;
- an override cannot change tools, permissions, validators, budgets, lifecycle authority, or human gates;
- rows must be inventoried without logging contents before retirement;
- approved custom behaviour moves into reviewed prompt files and tests;
- reads are disabled handler by handler;
- `setPrompt()`, `getPrompt()`, and the table are removed only after callers and retained rows reach zero through a separately approved migration.

## Prompt budgets

Prompt quality must not depend on unbounded context.

- Inject only context needed by the current role and mode.
- Bound every supplied variable before rendering.
- Keep planning evidence rich enough to establish product and architectural intent.
- Pass validated work packets and `RedTestSpec` records to execution rather than the whole planning transcript.
- Cap bodies, plan text, failure output, CI logs, diffs, and repository evidence.
- Keep the full human plan for approval and audit surfaces, not every CLI pass.
- Test template identity, required variables, rendered bounds, and sibling prompt isolation.

## Advisor-authored red tests

Technical Lead planning owns the test strategy. A plan is invalid when it says only `write tests`, `add unit tests`, or `increase coverage`.

Each planned red test identifies:

- mapped acceptance criteria and product intent;
- architecture boundaries, invariants, and triggered risks;
- exact test class, file, name, production boundary, fixture, and real caller action;
- authoritative expected result and oracle;
- why current code fails and the exact expected red assertion;
- focused red command;
- sibling behaviour remaining green;
- characterization needs and false-positive controls.

The active `implementation-plan-create.md` and `implementation-plan-improve.md` prompts use the same structured Red Tests and Red Test Coverage contracts. The existing plan validator fails closed when those sections or required fields are absent.

## Canonical role prompt families

### Technical Lead

- `technical_lead:requirements`
- `technical_lead:issue_validation`
- `technical_lead:issue_authoring`
- `technical_lead:planning`
- `technical_lead:planning_repair:red_tests`
- `technical_lead:planning_repair:execution_contract`
- `technical_lead:executor_guidance`
- `technical_lead:implementation_review`
- `technical_lead:operations_review`
- `technical_lead:pr_readiness`

### Code Worker

- `code_worker:scan:defect`
- `code_worker:scan:refactor`
- `code_worker:investigate`
- `code_worker:red`
- `code_worker:green`
- `code_worker:repair`
- `code_worker:verify`

### Documentation Steward

- `documentation_steward:impact`
- `documentation_steward:author`
- `documentation_steward:validate`
- `documentation_steward:maintenance`

## Legacy prompt families

Legacy keys remain compatibility aliases or inputs until their handler phase migrates:

- `feature_plan`;
- `implementation_plan:create`;
- `implementation_plan:improve`;
- `implementation_plan:contract_repair`;
- `defect_scan:*`;
- `refactor_scan:*`;
- `tdd_implementation:*`;
- `orchestrated_task:*`.

They must not silently become canonical role prompts. Status and audit should report their compatibility/degraded state.

## Skill supplements

Files under `supplements/` are compact, phase-specific guidance. Canonical role contracts do not gain authority from supplements. Legacy handlers may append their registered supplements within the existing prompt budget; database overrides do not receive them unless an existing caller explicitly opts in.
