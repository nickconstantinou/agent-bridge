# Agentic Worker Verification Contract

## Status

Canonical verification requirements for role-based Engineering Worker orchestration. Slice 1 activates only the exact role domain, desired assignment validation/persistence, schema-3 migration, and truthful dormant status. Later requirements apply as their owning Issue #159 slices activate behaviour.

## Test principles

- Write boundary-level acceptance tests before implementation.
- Preserve red-green-refactor with separate red and green commits for behaviour changes.
- Test authoritative state and externally observable effects rather than model wording.
- Treat issue mutation, permission, lifecycle, persistence, role resolution, prompts, canonical skills, structured output, exact-head evidence, and documentation triggers as risk boundaries.
- Require Technical Lead plans to define comprehensive red tests protecting product and architectural intent.
- Keep reusable SDLC know-how authoritative in versioned repository skills rather than copied prompt passages.
- Deterministic evidence overrides model claims.
- A stale required document or stale exact-head result is a failed readiness condition, not a deferred follow-up.

## Slice 1 acceptance suite

### Exact role domain and bounded configuration

Cover:

- exactly three externally configurable role IDs: `technical_lead`, `code_worker`, and `documentation_steward`;
- the exact mode registry without exposing modes as roles;
- exactly one assignment per role;
- explicit CLI/model primary and ordered fallback targets;
- `automatic`, `recommended`, and `manual` persisted only as desired selection labels;
- duplicate, missing, unknown, and mode-as-role rejection;
- bounded scope, CLI, model, and fallback counts;
- unknown-field rejection;
- credential-, secret-, prompt-, and repository-content-shaped field rejection;
- credential-shaped value rejection without echoing the value;
- existing bot configuration and legacy worker-chain parsing unchanged.

Slice 1 does not claim capability availability or permission suitability. Those are later resolution tests.

### Schema 2 → 3 migration and repository persistence

Use the existing schema registry, numbered migration boundary, repository SQL ownership, and `BridgeDb` façade. Cover:

- exact prior schema version 2 fixture creation using registered migrations 1 and 2;
- transactional migration to schema version 3;
- exact role-table shape and foreign keys;
- preservation of representative work items, jobs, approvals, GitHub links, advisor calls, and conversation turns;
- zero `foreign_key_check` violations;
- close/reopen persistence;
- current-revision lookup and ordered history;
- identical retry returns the same revision without a duplicate row;
- reused idempotency identity with changed input fails deterministically;
- persisted columns and values exclude credentials, prompts, and repository content;
- malformed pre-existing lookalike tables cause rollback, preserve schema version 2 and existing rows, and leave no partial child table;
- fresh and legacy migration suites continue to reach the declared current version.

### Guarded rollout qualification

Cover:

- the rollout inspector permits both role tables and no unrelated unknown table;
- an exact schema-2 database with current legacy queue/lock shape is `migratable`, not `current`;
- migration produces schema version 3 with both role tables;
- validation reports `current` only for exact schema version 3 plus required queue, lock, and role-table shape;
- queue counts, hashes, integrity, and rollback behaviour remain owned by the existing guarded helper tests.

### Dormant status and dispatch compatibility

Cover:

- `/chain` preserves its exact legacy-only response when no role revision exists;
- configured desired assignments are reported as `configured_dormant`;
- desired revision, source, primary, and fallback targets are visible without secrets;
- status states `Role routing: disabled`;
- status reports effective legacy interactive, code, and scribe chains;
- `resolveWorkerCliPolicy()` is identical with or without role-assignment environment values;
- every existing handler remains wired to its pre-Slice-1 execution owner;
- defect scan, feature plan, implementation plan, and refactor scan remain on the scribe chain;
- TDD implementation and orchestrated tasks remain on the code chain;
- GitHub issue and PR lifecycle paths remain on existing command/Git owners;
- no handler-map code references role assignment, capability resolution, or `configured_dormant` to select execution.

### Required focused commands for Slice 1

At the exact final head, run at minimum:

```text
npx vitest run test/agentRoles.test.ts
npx vitest run test/roleAssignmentRepository.test.ts
npx vitest run test/roleAssignmentMigrationRollback.test.ts
npx vitest run test/roleAssignmentDormantCompatibility.test.ts
npx vitest run test/rolloutDbRoleAssignments.test.ts
npx vitest run test/dbSchema.test.ts test/rolloutHelper.test.ts
```

Add all existing config, worker-command, worker-policy, database strict-open, and handler tests affected by the actual diff. Run lifecycle-sensitive migration/rollout tests serially or repeatedly when the repository contract requires it.

## Target-state acceptance suites — later slices

### Role resolution and degraded operation

Cover capability probes, automatic/recommended/manual resolution semantics, single-provider and single-model operation, model diversity, permission suitability, configuration source, desired/applied status, and required/actual review independence. A fresh same-model session is not independent.

### Requirements intake and multi-issue decomposition

Cover incomplete-input blocking, validation of apparently complete issues, repository-fact gathering, human product decisions, durable canonical issue revisions, restart idempotency, complete-bundle decomposition review before mutation, separate delivery/runtime orders, invariant matrices, overlap rejection, zero mutation on contradiction, and retry safety.

### Scan candidate handling

Cover read-only scans, candidate state, Technical Lead dispositions, duplicate/rejected/split handling, re-entry into bundle review, evidence requirements for refactors, and zero mutation authority from scan output.

### Technical Lead boundary

Cover the authoritative advisor service, bounded read-only tools, per-mode schemas and validators, focused repair, fail-closed output, and absence of shell, file, GitHub, merge, deployment, secret, or service capabilities.

### Prompt registry, lifecycle skills, and source isolation

Cover one registered prompt per role/mode, separate prompts and validators, explicit ordered lifecycle skills, exact skill identities/versions, fail-closed guidance composition, fallback identity preservation, bounded rendering, source-only prompt loading, migration-2 prompt-table retirement, and audit-safe hashes without raw context.

### Planning and target provenance

Cover `requirements_ready`, acceptance traceability, bounded execution packets, classified paths, owner/rationale, dependency refs, proposed-path justification, compatibility limits, and comprehensive `RedTestSpec` fields. Reject generic, helper-only, unclassified, or architecture-free tests.

### Focused plan repair

Cover separate red-test and execution-contract repair keys, field-scoped replacement, rejection of scope/architecture/permission/gate changes, one bounded repair, full-plan revalidation, and fail-closed multiple-invalid-section handling.

### Code Worker permission modes

Cover read-only scan/investigate, test-only committed red phase, immutable committed red tests during green, bounded repair, verification-only mode, and invocation-scoped capability revocation.

### Review, operations, documentation, and exact-head evidence

Cover canonical order, same-head binding, exact evidence statuses, authoritative `passed` requirements, independent-review policy, code-repair invalidation, manifest-triggered documentation, no-deferral readiness, and human-scope holds for material corrections.

### Lifecycle and persistence

Cover cancellation, terminal fencing, restart/lease recovery, task-wide budgets, completed-phase reuse, probe refresh, per-call prompt/skill identity, and rollback to legacy routing without record loss or unsafe interpretation.

## Structural checks

Architecture Lint should enforce or be supplemented by tests proving:

- role IDs/modes are centrally owned;
- role assignment SQL remains in one repository behind `BridgeDb`;
- configuration and status owners contain no SQL;
- role status is read-only;
- current handlers do not route through role assignments;
- one prompt-contract registry owns role/mode metadata;
- one lifecycle-skill registry owns extraction, versions, budgets, and composition;
- prompts and skills cannot own tool, permission, budget, or lifecycle authority;
- canonical prompt loading cannot depend on database prompt storage;
- documentation-only handlers cannot import production mutation helpers;
- later role-native handlers do not invoke provider CLIs directly and Technical Lead calls route through the advisor boundary.

## Final deterministic evidence

Final evidence includes:

```text
complete focused Slice 1 suite
migration/reopen/rollback qualification
full test suite
npm run typecheck
bash scripts/arch-lint.sh src
npm run cleanup:check or documented pre-existing findings
git diff --check
changed-path and unexpected-file audit
clean isolated worktree status
exact-head GitHub Actions checks
```

Each workflow/check is recorded separately as `passed`, `failed`, `not_run`, `not_scheduled`, `stale`, or `unknown`. A partial workflow must not be summarized as “CI passed.” Migration work additionally compares against the exact stacked base and records the exact prior/current schema versions.

## Live qualification

Production or appliance qualification is observational, separately approved, and never implicit on merge. For Slice 1 it must demonstrate guarded schema-3 migration across the real database inventory, dormant desired status, disabled role routing, unchanged effective legacy chains, queue/lease health, no duplicate revisions, secret-safe output, and protected rollback evidence.

Later broad role-routing rollout additionally demonstrates capability selection, requirements/decomposition workflows, permission enforcement, role-native execution/review/documentation, restart/cancellation, independent-review reporting, and rollback to legacy routing.
