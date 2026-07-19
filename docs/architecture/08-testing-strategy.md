# 08 — Testing Strategy

Strict red-green-refactor applies to every behaviour change. Acceptance and boundary tests are written before implementation; deterministic evidence outranks model claims.

## Test layers

| Layer | Location | Purpose |
|---|---|---|
| Acceptance | `test/acceptance/**` or current repository convention | End-to-end workflow, issue-mutation, exact-head, and structural intent |
| Integration | existing `test/*.test.ts` pattern | Handler, repository, advisor, provider, workspace, documentation, migration, and lifecycle seams |
| Unit | current pure-logic test locations | Validators, target provenance, ranking, schemas, and policy functions |
| Characterization | current integration fixtures | Preserve existing worker, provider, stored-plan, TDD, and compatibility behaviour before refactoring |
| Architecture Lint | `scripts/arch-lint.sh` | Ownership, permission, SQL, import, and bypass rules |
| Migration/rollback | database/config fixtures | Existing workspace upgrade and safe fallback |
| Disposable qualification | isolated repository/workspace | Real CLI/model and workflow evidence without production mutation |

## Per-slice protocol

1. Write characterization when current behaviour needs locking.
2. Write a failing behavioural or structural test.
3. Commit the red test without production implementation.
4. Confirm failure occurs for the intended reason.
5. Implement the smallest coherent change.
6. Commit production implementation separately.
7. Run focused tests, then broader verification.
8. Refactor only while tests remain green.
9. Evaluate and update every triggered required document.
10. Perform review, repair, fresh exact-head verification, and retrospective.

## Slice 1 dormant role suites

### Role and configuration

Test exactly three configurable roles and exact mode ownership; explicit bounded CLI/model assignments; ordered fallbacks; selection labels; duplicate/missing/unknown/mode-as-role rejection; unknown/credential/prompt/repository-content field rejection; secret-safe errors; configuration source; and unchanged legacy bot/worker-policy parsing.

Do not treat `automatic`, `recommended`, or `manual` labels as active resolution semantics. Capability/authentication/permission suitability is later-slice coverage.

### Persistence and migration

Test schema-2 representative fixtures, transactional migration to schema 3, exact role-table shape, repository-only SQL ownership, preservation of existing worker data, foreign-key integrity, close/reopen persistence, append-only revisions, deterministic identical retry, conflict on changed input with reused idempotency identity, malformed-table rollback, and absence of secret/prompt/content fields.

Test the guarded rollout boundary separately: schema 2 is `migratable`; schema 3 is `current` only with the required queue, lock, and both role tables.

### Dormant compatibility

Test the exact legacy `/chain` response when no revision exists. With a revision, test `configured_dormant`, desired source/revision/targets, `Role routing: disabled`, and explicit effective legacy interactive/code/scribe chains.

Structurally prove that every current handler remains wired to its existing scribe, code, Git, or GitHub owner and that role assignments do not participate in dispatch.

## Later role-orchestration suites

### Role resolution and degraded operation

Test automatic/recommended/manual semantics, capability rejection, non-mutating probes, per-role model selection from one CLI, one-model role separation, separate sessions and permission profiles, degradation reporting, required-versus-actual review independence, and policy-required holds.

### Requirements, issue contracts, and decomposition

Test feature, defect, and refactor schemas; apparently complete issue validation; missing product decisions; durable `requirements_ready`; facts versus hypotheses; refactor evidence; candidate dispositions; restart and retry.

For multi-issue work, test complete read-only bundle assembly, separate implementation/runtime ordering, one invariant matrix, zero mutation on conflict, idempotent issue mutation after `ready_for_issue_mutation`, and no partial mutation before consistency review.

### Planning and target provenance

Test comprehensive red-test contracts and exact target-path classification. New and repaired plans accept only `existing_at_base`, `existing_in_dependency`, `proposed_new_production`, or `proposed_new_test`, with owners, rationale, and exact dependency refs where required.

Test the narrow compatibility boundary separately: already-persisted pre-provenance plans may retain concrete path lists, while newly generated and repaired model output must never use that legacy path.

### Technical Lead boundary

Test that every mode routes through the existing AdvisorService, only typed bounded read-only evidence tools are reachable, freshness/authority metadata is preserved, output contracts are validated, repair is bounded, and mutation capabilities are absent.

### Code Worker modes

Test read-only scan/investigate, test-only red, production-only green, bounded repair, verification without new changes, capability revocation, and child-environment credential stripping.

### Review, operations, and evidence heads

Test deterministic verification before implementation review; implementation and applicable operations review before documentation; exact `subject_head_sha` equality across all later evidence; explicit `passed`, `failed`, `not_run`, `not_scheduled`, `stale`, and `unknown` states; and rejection of any non-passed required evidence.

Test that code-changing repair invalidates verification, review, operations, documentation, readiness, and CI evidence for the old head.

### Documentation Steward

Test manifest trigger evaluation, documentation-only mutation, deny precedence, required-document blocking, and validated `no_documentation_change` outcomes.

Missing, stale, contradictory, or materially misleading required documents must block readiness until corrected and revalidated in the same delivery. A deferred issue or assigned owner is not a passing outcome.

### Lifecycle

Test cancellation, timeout, lease loss, stale owner, restart after every phase, logical-call budgets across retry, terminal-state fencing, and rollback compatibility.

Detailed contract: `docs/testing/agentic-worker-verification.md`.

## Architecture Lint additions

Enforce or supplement with structural tests proving:

- role IDs and mode ownership have one owner;
- role-assignment SQL remains in one repository behind `BridgeDb`;
- configuration and status owners do not own SQL;
- current handlers cannot route using dormant role assignments;
- prompt and lifecycle-skill registries have one owner each;
- worker handlers cannot invoke provider CLIs directly for later role work;
- Technical Lead calls use AdvisorService;
- documentation authoring cannot import production mutation helpers;
- status and probe surfaces are read-only;
- legacy scribe calls cannot become canonical planning without an explicit compatibility marker.

## Required final verification

At the exact final head:

```bash
npm test
npm run typecheck
bash scripts/arch-lint.sh src
npm run cleanup:check
git diff --check
```

Slice 1 additionally runs the focused role-domain, repository/migration/reopen/idempotency, malformed-schema rollback, rollout qualification, and dormant-dispatch suites named in `docs/testing/agentic-worker-verification.md`.

Account for pre-existing cleanup findings and prove none were introduced in changed files. Run lifecycle/migration-sensitive suites repeatedly and serially where isolation risk warrants it. Verify exact-head GitHub Actions checks and state accurately when a workflow was not run or not scheduled.

## Live qualification

For Slice 1, a future separately approved production qualification demonstrates guarded schema-3 migration across the real database inventory, desired `configured_dormant` status, disabled role routing, unchanged effective legacy chains, queue/lease health, secret-safe output, and protected rollback evidence.

Later active-routing qualification demonstrates per-role capability/model selection, degraded operation, requirements/decomposition, planning/TDD, review/documentation, restart/cancellation, independence reporting, and rollback to legacy routing.

Production rollout is separately approved and is not implied by passing disposable qualification.
