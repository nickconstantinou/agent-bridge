# 10 — Production Readiness Checklist

Gate for enabling role-based Engineering Worker orchestration. Checked per release and rollout; automated where possible.

## Architecture

- [ ] Exactly three configurable roles: Technical Lead, Code Worker, Documentation Steward
- [ ] Scanner is a Code Worker mode; review and operations are Technical Lead modes
- [ ] Agent Bridge owns transitions, issue/PR mutation, permissions, budgets, approvals, and audit
- [ ] Technical Lead uses the authoritative AdvisorService boundary
- [ ] Provider/model capability and role resolution are registry-driven
- [ ] One central prompt registry owns role/mode contracts
- [ ] One central lifecycle-skill registry owns extraction, version checks, budgets, composition, and hashes
- [ ] Requirements, risk-based testing, TDD, and release readiness have one canonical skill source each
- [ ] Role, audit, and lifecycle SQL is confined to owning repositories
- [ ] Companion and worker architecture boundaries remain green
- [ ] `agentic-maintenance.yaml` references every existing canonical document, including current architecture

## Requirements, decomposition, and planning

- [ ] Feature, defect, and refactor inputs pass validation before planning
- [ ] Apparently complete GitHub/local issues receive validation
- [ ] Scan findings remain candidates until Technical Lead disposition
- [ ] `requirements_ready` is durable and restart-safe
- [ ] Product decisions pause for human input
- [ ] Multi-issue bodies are assembled without mutation before decomposition review
- [ ] Decomposition review separates implementation delivery order from runtime phase order
- [ ] One invariant matrix covers owners/callers, lifecycle/state, permissions, persistence, GitHub, platform/appliance, compatibility, and repair invalidation
- [ ] Inconsistent bundles produce zero GitHub issue mutations
- [ ] Technical Lead plans trace acceptance criteria and produce bounded work packets
- [ ] Every new or repaired plan target is classified as existing-at-base, dependency-owned, proposed production, or proposed test
- [ ] Dependency-owned paths include dependency PR and exact reviewed ref
- [ ] Invalid or unclassified targets fail closed
- [ ] Already-persisted pre-provenance plans use only the narrow compatibility validator
- [ ] Planning receives canonical requirements, risk-based testing, and TDD skills
- [ ] Structured output and bounded repair fail closed before persistence
- [ ] Legacy scribe planning is explicit compatibility behaviour only

## Role assignment

- [ ] Platform/OSS persist explicit CLI and model per role
- [ ] Automatic, recommended, and manual assignment work
- [ ] Ordered fallbacks and configuration source are visible
- [ ] One CLI can assign different models to different roles
- [ ] One model preserves role/session/prompt/skill/permission separation
- [ ] Model-diversity state is accurate and separate from review independence
- [ ] Technical Lead role-separation review remains available with one model
- [ ] Role test probes are non-mutating and freshness-aware

## Security and permissions

- [ ] Technical Lead has typed bounded read-only tools only
- [ ] Code Worker scan/investigate cannot mutate
- [ ] Red mode is test-only and green cannot modify committed red tests
- [ ] Repair cannot escape the approved packet
- [ ] Documentation author mode is restricted to manifest-approved paths
- [ ] Capability tokens expire on completion, cancellation, timeout, and lease loss
- [ ] Child environments strip credentials not required by the role mode
- [ ] Prompt and skill text cannot grant tools, permissions, budgets, lifecycle authority, or human-gate exceptions
- [ ] Status, probes, and audit contain no secrets or unrestricted prompt content

## Reliability and lifecycle

- [ ] Cancellation prevents new role calls and fences late output
- [ ] Terminal states cannot be overwritten
- [ ] Restart resumes from authoritative phase state
- [ ] Completed role phases are not repeated
- [ ] Lease loss/stale owner cannot dispatch or persist duplicate calls
- [ ] Logical-call budgets survive retry and restart
- [ ] Prompt key/version, role-template hash, lifecycle skill identities, skill-set hash, composed-template hash, and rendered hash remain bound to each logical call
- [ ] Provider fallback preserves the same prompt and lifecycle-skill identities
- [ ] Missing, malformed, duplicate, oversized, or version-mismatched skill guidance fails closed before a model call
- [ ] Provider and model probes are revalidated when stale
- [ ] Role routing rollback preserves new records and holds incompatible jobs safely

## Code Worker

- [ ] Disposable workspaces remain mandatory
- [ ] Mechanical red/green commit separation remains active
- [ ] Red and green modes consume canonical TDD guidance rather than a copied supplement
- [ ] Red mode also receives canonical risk-based testing guidance
- [ ] Deterministic focused and broad verification precedes review
- [ ] Scope expansion is rejected or returned for new planning
- [ ] PR head-SHA, CI, and merge approval gates remain unchanged

## Review and exact-head evidence

- [ ] Implementation review runs only after deterministic verification
- [ ] Implementation review occurs before Documentation Steward authoring
- [ ] Operations review occurs before documentation when triggered
- [ ] Review, operations, documentation, readiness, CI, and final review records carry the same current `subject_head_sha`
- [ ] Required gate status distinguishes passed, failed, not run, not scheduled, stale, and unknown
- [ ] Only authoritative passed evidence for the exact current head satisfies a required gate
- [ ] `not_run`, `not_scheduled`, stale, unknown, failed, and moved-head evidence are never reported as green
- [ ] Final review is performed by a read-only Technical Lead advisor
- [ ] Reviewer role is separate from the mutating Code Worker
- [ ] Reviewer did not author or modify the reviewed implementation
- [ ] Review invocation has no mutation authority
- [ ] Review is a fresh invocation against the exact checked head
- [ ] Same CLI/model reuse is permitted and model diversity is non-blocking metadata
- [ ] Prior read-only Technical Lead planning or advice does not disqualify the reviewer
- [ ] Code Worker self-review is rejected
- [ ] Any code-changing repair invalidates verification, review, operations, documentation, readiness, CI, and final-review evidence for the previous head

## Documentation

- [ ] Documentation impact is recorded for every planned change
- [ ] Manifest triggers resolve required documents deterministically
- [ ] Every required document is current and exact-head validated before PR readiness
- [ ] Missing, stale, contradictory, or materially misleading required documentation blocks readiness
- [ ] Required documentation is corrected and revalidated in the same delivery
- [ ] A later issue, owner assignment, archive recommendation, or follow-up does not satisfy readiness
- [ ] Material scope required for documentation correction produces a human-scope hold, not deferral
- [ ] `no_documentation_change` requires rationale, trigger evaluation, and Technical Lead validation
- [ ] Current architecture, README, AGENTS, worker guide, target architecture, ADR, configuration, operations, testing, and maintenance documents are current
- [ ] Documentation Steward cannot change production or test code

## Operations

- [ ] Implementation and PR-readiness review consume canonical risk/readiness skill mappings
- [ ] Operations review consumes canonical release-readiness guidance
- [ ] Effective role/status reports targets, models, permissions, fallbacks, prompt/skill identities, source, role separation, and model-diversity metadata
- [ ] Safe enablement completed in a disposable workspace
- [ ] Operator runbook covers enablement, degradation, cancellation, restart, incident, and rollback
- [ ] Deployment/rollback plan identifies prerequisites, abort conditions, postconditions, and exact evidence
- [ ] No production mutation occurs without separate explicit approval

## Verification

- [ ] Every canonical skill has exactly one marked runtime block and matching manifest version
- [ ] Every role/mode and compatibility prompt declares an explicit skill mapping
- [ ] Skill drift changes only consuming composed/rendered identities
- [ ] Compatibility and role-native prompts use the same canonical skill loader
- [ ] Focused decomposition, prompt, skill, target-provenance, workflow, permission, exact-head, documentation, review-independence, lifecycle, migration, and platform tests pass
- [ ] Full suite passes at exact head
- [ ] Typecheck passes
- [ ] Architecture Lint passes
- [ ] Cleanup/static checks pass or only documented pre-existing findings remain
- [ ] `git diff --check` passes
- [ ] Lifecycle/concurrency-sensitive suites pass repeatedly and serially where required
- [ ] Exact-head GitHub Actions checks pass
- [ ] Disposable qualification covers single-CLI and single-model operation

## Recovery

- [ ] Database migration and rollback verified on representative existing worker databases
- [ ] Prompt and lifecycle-skill rollback is reproducible through an exact reviewed application SHA
- [ ] Role configuration can be disabled without deleting assignments or audit
- [ ] Legacy routing is restored only through explicit validated configuration
- [ ] Jobs using incompatible new states are held for human review
- [ ] Queue, lease, and service health are verified after rollback
- [ ] Protected backup and exact application SHA are recorded before production rollout

## Human gates

- [ ] Unresolved product decisions require human input
- [ ] Material scope changes require human approval
- [ ] Merge remains explicitly approved
- [ ] Destructive Git, service restart, deployment, secret/config/permission change, cap exception, and policy change remain explicitly approved
