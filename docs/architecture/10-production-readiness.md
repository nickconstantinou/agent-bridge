# 10 — Production Readiness Checklist

Gate for role-based Engineering Worker releases and rollouts. Checked per slice, release, and production change; automated where possible. Slice 1 is a dormant persistence release and must not be evaluated as active role routing.

## Slice 1 — dormant role persistence

### Architecture and scope

- [ ] Exactly three configurable roles: Technical Lead, Code Worker, Documentation Steward
- [ ] Modes are centrally owned and cannot be configured as roles
- [ ] Desired assignments contain explicit bounded CLI/model targets and ordered fallbacks
- [ ] Role configuration, persistence, and status extend existing owners
- [ ] Role SQL is confined to one repository behind `BridgeDb`
- [ ] No second queue, workflow engine, state store, SQL path, migration runner, supervisor, provider path, prompt service, status authority, GitHub mutation path, or merge path exists
- [ ] Role routing is disabled
- [ ] Existing interactive, code, and scribe chains remain effective
- [ ] Every existing handler remains on its pre-Slice-1 dispatch path
- [ ] Capability resolution, permission profiles, role-native prompts, requirements lifecycle, review phases, and Platform transport remain absent

### Configuration and security

- [ ] Configuration contains exactly one assignment for each public role
- [ ] Duplicate, missing, unknown, mode-as-role, malformed, and unbounded inputs fail closed
- [ ] Unknown fields fail closed
- [ ] Credential-, secret-, prompt-, and repository-content-shaped fields fail closed
- [ ] Credential-shaped values fail closed without value disclosure
- [ ] Persisted schema and status contain no token, API key, secret, raw prompt, or repository content
- [ ] Existing bot configuration and worker-chain parsing remain unchanged

### Persistence and migration

- [ ] Current schema version is derived from the approved base and advances from 2 to 3
- [ ] Migration 3 is registered through the existing numbered registry
- [ ] `role_assignment_revisions` and `role_assignments` are additive and exact-shape validated
- [ ] Foreign keys and JSON fallback validity are enforced
- [ ] Representative schema-2 worker data survives migration unchanged
- [ ] Close/reopen persistence succeeds
- [ ] Identical retry is idempotent and changed input under the same key conflicts deterministically
- [ ] Malformed pre-existing role tables roll back transactionally without advancing `user_version`
- [ ] `foreign_key_check` is clean
- [ ] Production startup remains strict and does not auto-migrate
- [ ] Rollout inspection classifies schema 2 as `migratable`, not `current`
- [ ] Rollout validation classifies only exact schema 3 with both role tables as `current`
- [ ] Guarded helper backup, integrity, queue, restart, and rollback contracts remain intact

### Status and compatibility

- [ ] No role revision preserves the exact legacy `/chain` response
- [ ] A desired revision is labelled `configured_dormant`
- [ ] Desired revision and source are visible
- [ ] Desired primary/fallback targets are visible without secrets
- [ ] Status states `Role routing: disabled`
- [ ] Effective legacy interactive, code, and scribe chains are visible
- [ ] Desired assignments are never labelled effective

### Review and exact-head evidence

- [ ] Baseline and characterization evidence is bound to the approved stacked base
- [ ] Red tests were committed separately and proved intended missing behaviour
- [ ] Production implementation was committed separately without weakening committed red tests
- [ ] Repairs are narrow, separately identifiable, and invalidate downstream evidence for prior heads
- [ ] Deterministic focused and broad verification runs at one exact final head
- [ ] Implementation review has no unresolved blocker
- [ ] Operations/migration review has no unresolved blocker
- [ ] Documentation authoring follows accepted implementation/operations evidence
- [ ] Documentation validation has no stale, contradictory, missing, or materially misleading required document
- [ ] PR readiness uses the same exact final head
- [ ] Required gate status distinguishes `passed`, `failed`, `not_run`, `not_scheduled`, `stale`, and `unknown`
- [ ] `not_run`, `not_scheduled`, stale, unknown, failed, and moved-head evidence are never reported as green
- [ ] Required and actual independent-review levels are recorded separately
- [ ] Same-model fresh-session review is not reported as independent
- [ ] Required unavailable independence blocks READY FOR HUMAN REVIEW

### Documentation

- [ ] Manifest triggers for database migration, status surface, provider/model desired state, and lifecycle compatibility were evaluated
- [ ] Current architecture reflects schema 3 and dormant assignments
- [ ] Configuration explains exact current input, persistence, and status behaviour
- [ ] Operations explains guarded migration and rollback
- [ ] Testing names exact focused Slice 1 suites
- [ ] Worker-facing documentation explains `/chain` desired/effective output
- [ ] Production-readiness and documentation index are current
- [ ] Required documentation was corrected and validated in this delivery, not deferred
- [ ] Documentation Steward changed only manifest-approved documentation paths

### Verification

- [ ] Complete focused Slice 1 suite passes
- [ ] Migration, reopen, idempotency, malformed-schema rollback, and rollout qualification pass
- [ ] Dormant-dispatch compatibility passes across every Issue #161 handler path
- [ ] Full suite passes at exact head
- [ ] Typecheck passes
- [ ] Architecture Lint passes
- [ ] Cleanup/static checks pass or only documented pre-existing findings remain
- [ ] `git diff --check` passes
- [ ] Lifecycle/migration-sensitive suites pass serially or repeatedly where required
- [ ] Exact-head GitHub Actions checks pass
- [ ] Changed-path/unexpected-file audit passes
- [ ] Isolated worktree is clean

### Safety and human gates

- [ ] No production checkout, database, service, queue, appliance, or Platform mutation occurred during implementation/review
- [ ] No service restart or deployment occurred
- [ ] No issue close, PR-ready transition, merge, or later-slice activation occurred without maintainer instruction
- [ ] Protected backup and exact application SHA are required before any future production rollout

## Later active role orchestration gate

The following remain mandatory before any later slice can enable role routing.

### Architecture

- [ ] Agent Bridge owns transitions, issue/PR mutation, permissions, budgets, approvals, and audit
- [ ] Technical Lead uses the authoritative AdvisorService boundary
- [ ] Provider/model capability and role resolution are registry-driven
- [ ] One central prompt registry owns role/mode contracts
- [ ] One central lifecycle-skill registry owns extraction, version checks, budgets, composition, and hashes
- [ ] Requirements, risk-based testing, TDD, and release readiness have one canonical skill source each
- [ ] Companion and worker architecture boundaries remain green
- [ ] `agentic-maintenance.yaml` references every existing canonical document

### Requirements, decomposition, and planning

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
- [ ] Every new or repaired plan target is classified and owned
- [ ] Invalid or unclassified targets fail closed
- [ ] Planning receives canonical requirements, risk-based testing, and TDD skills
- [ ] Structured output and bounded repair fail closed before persistence

### Role resolution and permissions

- [ ] Automatic, recommended, and manual assignment semantics are implemented
- [ ] Capability/authentication probes are authoritative and freshness-aware
- [ ] One CLI can assign different models to different roles
- [ ] One model preserves role/session/prompt/skill/permission separation
- [ ] Model-diversity state is accurate and separate from review independence
- [ ] Technical Lead role-separation review remains available with one model
- [ ] Role test probes are non-mutating and freshness-aware

## Security and permissions
- [ ] Technical Lead has typed bounded read-only tools only
- [ ] Code Worker modes enforce read-only/test-only/bounded-mutation/verification-only permissions
- [ ] Documentation author mode is restricted to manifest-approved paths
- [ ] Capability tokens expire on completion, cancellation, timeout, and lease loss
- [ ] Child environments strip credentials not required by the role mode
- [ ] Prompt and skill text cannot grant authority or bypass human gates

### Reliability and lifecycle

- [ ] Cancellation prevents new role calls and fences late output
- [ ] Terminal states cannot be overwritten
- [ ] Restart resumes from authoritative phase state
- [ ] Lease loss/stale owner cannot dispatch or persist duplicate calls
- [ ] Logical-call budgets survive retry and restart
- [ ] Prompt/skill/render identities remain bound to each logical call
- [ ] Provider fallback preserves identities
- [ ] Missing or invalid skill guidance fails closed before model call
- [ ] Role-routing rollback preserves records and holds incompatible jobs safely

### Code Worker, review, documentation, and operations

- [ ] Disposable workspaces remain mandatory
- [ ] Mechanical red/green commit separation remains active
- [ ] Deterministic verification precedes implementation review
- [ ] Operations review precedes documentation when triggered
- [ ] Documentation Steward authoring/validation precedes PR readiness
- [ ] All evidence binds to one exact current head
- [ ] Required documentation is corrected and validated in the same delivery
- [ ] Effective status reports targets, permissions, prompt/skill identities, source, and degradation
- [ ] Safe enablement completes in a disposable workspace
- [ ] Deployment/rollback identifies prerequisites, abort conditions, postconditions, and exact evidence
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
