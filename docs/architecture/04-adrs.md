# 04 — Architecture Decision Records

Format: Context → Decision → Consequences → Status.

## ADR-001: ProviderAdapter interface over BotKind branching
- **Context:** Kimchi integration required edits to 9+ files (types, cli, effort, timeouts, commands, db, 4 entry points, interactiveBot, sessionRepository). Branch logic in `cli.ts` mixes all providers.
- **Decision:** One `ProviderAdapter` interface per CLI in `src/providers/`, registered in a `ProviderRegistry`. `BotKind` derived from registry keys. Adapters own: invocation build, result parse, session resolve, error classification, effort mapping, timeout profile, capabilities, health probe.
- **Consequences:** Adding a provider = one file + registry entry + env token. Existing behaviour preserved by wrapping current functions (strangler). Error classification moves out of the shared `isCapacityExhaustedError` (fixes G6 class of bugs permanently).
- **Status:** Proposed.

## ADR-002: Event-sourced worker lifecycle, columns as materialized view
- **Context:** `bridge_events`/`EventStore` exist but only for companion runs. Worker mutates `work_jobs.status` directly; history is unrecoverable; two truths.
- **Decision:** Extend `BridgeEvent` with JobCreated, JobStarted, ProviderSelected, ToolCalled, CommitCreated, PRCreated, ReviewReceived, CIStarted, CIFailed, RepairStarted, RepairFinished, ApprovalRequested, Merged, Completed. Emission is mandatory in jobExecutor transitions. `events/reducer.ts` derives job/PR state; status columns updated in the same transaction (materialized view, not source).
- **Consequences:** Replay/debug/metrics from one log. No new infra (stays SQLite, in-process subscribers). Dual-write phase carries divergence risk — mitigated by reducer-vs-column consistency test in CI.
- **Status:** Proposed.

## ADR-003: Declarative workflow definitions
- **Context:** feature/defect/refactor pipelines duplicate step logic inside per-task_type handlers; adding "documentation" or "dependency upgrade" means a new handler file.
- **Decision:** `Workflow` data structures (steps referencing named skills + step executors, gates, repair policy) interpreted by `workflowEngine.ts`. jobExecutor keeps the handler-map seam; the workflow engine is registered as the handler for workflow-driven task types.
- **Consequences:** New workflow = new declaration. Existing handlers wrapped as single-step workflows first — zero behaviour change during migration. Gates (plan approval, merge approval) become reusable.
- **Status:** Proposed.

## ADR-004: SQLite stays; no external broker
- **Context:** Single-host deployment; better-sqlite3 synchronous API underpins locks and idempotency; ops burden of Postgres/Redis unjustified at current scale.
- **Decision:** Keep SQLite for state + events. Define repository interfaces narrowly so a future Postgres port is a repository swap, not an application rewrite. Event subscribers are in-process.
- **Consequences:** Horizontal scale deferred deliberately; multi-workspace remains process-per-workspace (matches appliance model).
- **Status:** Accepted (reaffirms status quo).

## ADR-005: GitHub issues as record of truth for work intake
- **Context:** /import and /list-issues are dead; externally-created issues invisible; user explicitly wants external issues workable.
- **Decision:** GitHub authoritative for work-item existence/description/closure of externally-created items. Sync job imports open issues → `work_items` (source=github), pushes status labels + closing comments back. Execution state (jobs, runs, attempts) stays SQLite-only.
- **Consequences:** Conflict rule needed: GitHub wins on content, bridge wins on execution status. Offline tolerance: sync is eventually consistent, worker never blocks on GitHub availability.
- **Status:** Proposed.

## ADR-006: OSS/platform boundary via two stable APIs
- **Context:** Appliance (`/opt/agent-bridge`) shares tokens and concepts with OSS repo ad hoc; a token collision broke Agy polling in production.
- **Decision:** OSS exposes (a) Workspace Bootstrap API (config handshake: tokens, allowed users, repos) and (b) Heartbeat/Status API. Platform implements auth/billing/provisioning against these. Env namespaces separated (`AB_OSS_*` vs `AB_PLATFORM_*`); every bot surface gets a dedicated Telegram token, enforced by install validation.
- **Consequences:** Appliance becomes an OSS consumer; no more shared-token classes of failure; hosted platform can evolve independently.
- **Status:** Proposed.

## ADR-007: Strict TDD with architectural acceptance criteria
- **Context:** Two shipped defects passed tests while missing architectural intent (repositories unwired; vitest in src).
- **Decision:** Every epic starts with acceptance tests (may be lint-style/structural, e.g. "BridgeDb contains no `prepare(` calls"). `scripts/arch-lint.sh` runs in pre-commit and worker acceptance: no vitest imports in src, no raw SQL outside repositories, no cross-layer imports (providers must not import telegram; workflows must not import providers directly).
- **Consequences:** Intent regressions fail CI, not review. Worker bot acceptance-criteria templates updated to include structural assertions.
- **Status:** Accepted (partially implemented in tddImplementation TEST_ONLY_SOURCE_PATTERN).
