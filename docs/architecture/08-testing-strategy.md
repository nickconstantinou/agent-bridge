# 08 — Testing Strategy

Strict red-green-refactor applies to every behaviour change. Acceptance and boundary tests are written before implementation; deterministic evidence outranks model claims.

## Test layers

| Layer | Location | Purpose |
|---|---|---|
| Acceptance | `test/acceptance/**` or current repository convention | End-to-end workflow, issue-mutation, exact-head, and structural intent |
| Integration | existing `test/*.test.ts` pattern | Handler, repository, advisor, provider, workspace, documentation, and lifecycle seams |
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

## Role orchestration suites

### Role and configuration

Test exactly three configurable roles, explicit CLI/model assignments, automatic/recommended/manual selection, ordered fallbacks, capability rejection, configuration-source status, and legacy-chain precedence.

### Single CLI and model

Test per-role model selection from one CLI, one-model role separation, separate sessions and permission profiles, degradation reporting, required-versus-actual review independence, and policy-required holds.

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

- role IDs and mode-permission mappings have one owner;
- prompt and lifecycle-skill registries have one owner each;
- worker handlers cannot invoke provider CLIs directly for role work;
- Technical Lead calls use AdvisorService;
- documentation authoring cannot import production mutation helpers;
- role and audit SQL remains in owning repositories;
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

Account for pre-existing cleanup findings and prove none were introduced in changed files. Run lifecycle/concurrency-sensitive suites repeatedly and serially where isolation risk warrants it. Verify exact-head GitHub Actions checks and state accurately when a workflow was not run or not scheduled.

## Live qualification

Use a disposable workspace to demonstrate:

- one CLI with per-role model selection;
- one-model degraded operation;
- requirements clarification and validation of a complete issue;
- inconsistent multi-issue decomposition blocked before mutation;
- rejected scan candidate;
- classified Technical Lead plan and approved TDD implementation;
- implementation review before documentation;
- stale required documentation blocking readiness until corrected;
- restart and cancellation without duplicate calls;
- accurate independent/non-independent review;
- rollback to legacy routing without queue or state corruption.

Production rollout is separately approved and is not implied by passing disposable qualification.
