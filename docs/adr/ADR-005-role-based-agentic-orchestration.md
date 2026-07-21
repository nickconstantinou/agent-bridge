# ADR-005 — Use Role-Based Agentic Orchestration

## Status

Accepted.

## Context

The Engineering Worker historically divided jobs into code-writing and scribe/read-only CLI chains. Feature and implementation planning assumed that an incoming brief, local work item, GitHub issue, or scan finding was sufficiently specified for a scribe CLI to produce the canonical plan.

That model has three weaknesses:

1. Incoming requirements may be incomplete, ambiguous, stale, or based on unsupported assumptions.
2. The most consequential artefacts—the canonical issue and implementation plan—may be assigned to a cheaper prose target instead of the strongest repository-grounded reasoning path.
3. Provider chains express transport fallback but do not express responsibility, permissions, model capability, or lifecycle contracts.

PR #157 exposed a concrete symptom: the default scribe repeatedly omitted the required execution contract and needed a specialised structural repair call. The repair and fail-closed validation remain useful, but they do not establish the target architecture.

Agent Bridge already has an authoritative advisor service, bounded calls, provider fallback, audit, structured output, and planned typed read-only evidence through Issues #100 and #146.

## Decision

Agent Bridge exposes exactly three configurable Engineering Worker roles:

- **Technical Lead** — requirements discovery and validation, canonical issue authoring, implementation planning, task decomposition, bounded guidance, implementation review, operations review, and PR-readiness advice;
- **Code Worker** — read-only defect/refactor scanning and investigation plus bounded TDD implementation, repair, and verification;
- **Documentation Steward** — documentation impact, documentation-only authoring, and documentation validation.

Independent review and operations are Technical Lead modes. Repository scanning is a Code Worker mode. They are not separate platform roles.

Agent Bridge remains the authoritative orchestrator for workflow state, role resolution, permissions, evidence, budgets, retries, cancellation, approvals, merge, deployment, and audit.

The Technical Lead uses the strongest configured read-only advisor path. No implementation plan is created until the canonical issue is `requirements_ready`.

The platform binds each role to an authenticated CLI, explicit model, fallbacks, permission profiles, and budgets. One authenticated CLI may expose different models to different roles. One available frontier model may serve every role through separate sessions and permissions.

Target-state role and authority separation requires that a Technical Lead reviewer did not author or modify the reviewed implementation, has no mutation authority in the review invocation, and performs a fresh review of the exact checked head. Issue #161 uses a stricter delivery gate without changing the later target-state option: a same-model fresh session is `non_independent` and a genuinely independent frontier reviewer is required.

## Consequences

Positive:

- requirements quality becomes an explicit lifecycle gate;
- scan findings cannot approve themselves;
- strong reasoning is concentrated on requirements, planning, and review;
- cheaper coding models receive bounded work packets;
- role authority is independent of provider identity;
- documentation becomes a deterministic readiness obligation;
- single-provider and single-model installations remain usable without weakening the Technical Lead/Code Worker review boundary.

Trade-offs:

- role, assignment, capability, validation, audit, and lifecycle contracts must be persisted;
- advisor budgets become phase-aware rather than occasional checkpoint-only limits;
- the platform needs role/model configuration and effective-status UI;
- documentation-only mutation needs enforceable path policy;
- legacy worker-chain migration and rollback must be maintained during rollout.

Risks and controls:

- the Technical Lead must not become an autonomous authority: Agent Bridge owns every transition and permission;
- same-model review may correlate reasoning errors: Issue #161 therefore requires a genuinely independent frontier review in addition to deterministic evidence, a fresh exact-head read-only Technical Lead boundary, and the human merge gate;
- the Code Worker must not self-review its own mutation: reviewer role, mutation history, invocation authority, and exact head are recorded;
- requirements discovery may over-call models: calls are bounded, structured, durable, and driven by unresolved facts or decisions;
- read-only evidence tools may escape their boundary: tools are typed, allowlisted, budgeted, audited, and Bridge-owned.

## Alternatives considered

### Keep scribe-led planning and add more repair prompts

Rejected as the target architecture. It hardens output structure but does not solve requirements quality or role authority.

### Expose separate scanner, reviewer, and operations roles

Rejected. Scanner and Code Worker share repository capability under different modes. Reviewer and operations reasoning belong to the Technical Lead.

### Require a separate provider or model for every role

Rejected as a universal target-state rule because it would make single-CLI or single-model workspaces unusable and confuses provider/model diversity with role and authority isolation. Issue #161's final delivery review is the narrower exception and remains held when no genuinely independent frontier reviewer is available.

### Let the Technical Lead dispatch or mutate directly

Rejected. Agent Bridge must remain authoritative for state, permissions, transitions, and gates.

## Compatibility

`WORKER_CODE_CLI_CHAIN` and `WORKER_SCRIBE_CLI_CHAIN` may remain explicit migration inputs or legacy fallback. They are not authoritative after role assignments are persisted. Existing fail-closed plan validation remains until the replacement path is fully qualified.

## Implementation Guidance

- Reuse the current AdvisorService; do not create a second advisor service.
- Coordinate typed read-only evidence with Issues #100 and #146.
- Coordinate cancellation, restart, lease loss, and stale ownership with Issue #119.
- Revise Issue #132's checkpoint-only assumptions rather than duplicating plan/review services.
- Record reviewer role, exact target, mutation separation, fresh invocation, and exact reviewed head.
- Use `agentic-maintenance.yaml` to enforce documentation triggers and authoring paths.
- Follow `docs/roadmap/issue-159-role-based-orchestration.md`.
