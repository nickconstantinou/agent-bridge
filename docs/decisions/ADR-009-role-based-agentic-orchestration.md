# ADR-009: Role-Based Agentic Orchestration

## Status

Accepted.

## Context

The Engineering Worker historically divided jobs into code-writing and scribe/read-only CLI chains. Feature planning and implementation planning assumed the incoming brief or GitHub issue was sufficiently specified and used a scribe CLI to create the canonical plan.

That model has three weaknesses:

1. Imported issues, local work items, and scan findings may be incomplete, ambiguous, stale, or based on unsupported assumptions.
2. The most consequential artefact—the implementation plan—may be assigned to a cheaper prose target instead of the strongest repository-grounded reasoning path.
3. Provider chains express transport fallback but do not express the responsibility, permissions, model quality, or lifecycle contract required by each engineering phase.

PR #157 exposed a concrete symptom: the default scribe repeatedly omitted the required execution contract and needed a focused structural repair call. The repair and fail-closed validation are valuable, but they do not establish the desired planning architecture.

Agent Bridge already has an authoritative advisor service, bounded logical-call budgets, audit, provider fallback, structured output, and planned read-only evidence tools through Issues #100 and #146.

## Decision

Agent Bridge exposes three configurable Engineering Worker roles:

- **Technical Lead**: requirements, canonical issues, plans, task decomposition, guidance, implementation review, operations review, and PR readiness;
- **Code Worker**: read-only scans and investigation plus bounded TDD implementation, repair, and verification;
- **Documentation Steward**: documentation impact, documentation-only authoring, and documentation validation.

Independent reviewer and operations steward are Technical Lead modes. Repository scanner is a Code Worker mode.

Agent Bridge remains the authoritative orchestrator. Role models do not own workflow state, permissions, transitions, approvals, merge, deployment, or destructive actions.

The Technical Lead uses the strongest configured read-only advisor path and may inspect typed, allowlisted, bounded repository and execution evidence. It writes and validates canonical issues and implementation plans only after requirements are complete.

The platform binds each role to an authenticated CLI, explicit model, fallbacks, permission profiles, and budgets. A single authenticated CLI can expose different models to different roles. A single available model can serve all roles with separate sessions and permissions, while model diversity and independent-model review are reported unavailable.

## Consequences

### Positive

- Requirements quality becomes an explicit lifecycle gate.
- Scan findings cannot promote themselves into implementation work.
- The strongest reasoning target is used for issue and plan quality rather than routine mutation.
- Cheaper coding models receive bounded, unambiguous work packets.
- Role authority is independent of provider authentication.
- Permission profiles are explicit per mode.
- Documentation becomes a deterministic workflow obligation.
- Single-provider installations remain functional without hiding degraded independence.

### Costs

- New durable role, assignment, capability, validation, and audit contracts are required.
- Advisor call budgets must be phase-aware rather than limited to occasional checkpoints.
- The platform needs role/model assignment UI and effective-status projection.
- Legacy chain migration and rollback must be supported.
- Documentation-only mutation requires enforceable path policy.

### Risks

- A Technical Lead could become an unrestricted autonomous planner if Agent Bridge delegates lifecycle authority. This is prohibited.
- Same-model review can create correlated errors. Status must report non-independent review and policy may block high-risk work.
- Requirements discovery can create excessive model calls. Calls remain bounded, structured, resumable, and driven by missing decisions.
- Tool-enabled advice can escape the read-only boundary. Tools remain typed, allowlisted, budgeted, and Bridge-owned.

## Alternatives considered

### Keep scribe-led planning and add more repair prompts

Rejected as the target architecture. It hardens output structure but leaves requirements quality and role authority unresolved.

### Expose six separate roles

Rejected. Scanner and Code Worker need the same repository capabilities under different permission modes. Reviewer and operations reasoning belong to the Technical Lead and can use a different target without adding platform roles.

### Require a separate provider for every role

Rejected. It would make single-CLI workspaces unusable and confuses provider diversity with role isolation.

### Let the Technical Lead directly dispatch or mutate

Rejected. Agent Bridge must remain authoritative for permissions, transitions, state, and gates.

## Compatibility

`WORKER_CODE_CLI_CHAIN` and `WORKER_SCRIBE_CLI_CHAIN` may remain as explicit migration inputs or legacy fallback. They are not authoritative after role assignments are persisted. Existing fail-closed plan validation remains until the replacement path is fully qualified.

## Related work

- Issue #159: implementation epic;
- Issue #132: existing advisor checkpoint scope, revised by this decision;
- Issue #100: bounded advisor debug and read-only repository evidence;
- Issue #146: freshness-aware advisor evidence;
- Issue #119: durable worker lifecycle;
- PR #157: transitional implementation-plan contract recovery.