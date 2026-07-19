# 08 — Testing Strategy

Strict red-green-refactor applies to every behaviour change. Acceptance and boundary tests are written before implementation; deterministic evidence outranks model claims.

## Test layers

| Layer | Location | Purpose |
|---|---|---|
| Acceptance | `test/acceptance/**` or the current repository acceptance convention | End-to-end workflow and structural intent |
| Integration | existing `test/*.test.ts` pattern | Handler, repository, advisor, provider, workspace, and lifecycle seams |
| Unit | current pure-logic test locations | Validators, ranking, schemas, and policy functions |
| Characterization | current integration fixtures | Preserve existing worker, provider, TDD, and compatibility behaviour before refactoring |
| Architecture Lint | `scripts/arch-lint.sh` | Ownership, permission, SQL, import, and bypass rules |
| Migration/rollback | database/config fixtures | Existing workspace upgrade and safe fallback |
| Disposable qualification | isolated repository/workspace | Real CLI/model and workflow evidence without production mutation |

## Per-slice protocol

1. Write a failing behavioural or structural test.
2. Commit the red test without production implementation.
3. Confirm failure occurs for the intended reason.
4. Implement the smallest coherent change.
5. Commit production implementation separately.
6. Run focused tests, then broader verification.
7. Refactor only while tests remain green.
8. Perform the required retrospective.

## Role orchestration suites

### Role and configuration

Test exactly three configurable roles, explicit CLI/model assignments, automatic/recommended/manual selection, ordered fallbacks, capability rejection, configuration-source status, and legacy-chain precedence.

### Single CLI and model

Test per-role model selection from one CLI, one-model role separation, separate sessions and permission profiles, degradation reporting, and policy-required independent review.

### Requirements and issue contracts

Test feature, defect, and refactor schemas; apparently complete issue validation; missing product decisions; durable `requirements_ready`; facts versus hypotheses; refactor evidence; candidate-finding dispositions; restart and retry.

### Technical Lead boundary

Test that every mode routes through the existing AdvisorService, only typed bounded read-only evidence tools are reachable, freshness/authority metadata is preserved, output contracts are validated, repair is bounded, and mutation capabilities are absent.

### Code Worker modes

Test read-only scan/investigate, test-only red, production-only green, bounded repair, verification without new changes, capability revocation, and nested child environment stripping.

### Documentation Steward

Test manifest trigger evaluation, documentation-only mutation, deny precedence, required-document readiness blocking, and validated `no_documentation_change` outcomes.

### Review and operations

Test different-target preference, fresh-session fallback, accurate independence status, deterministic-evidence precedence, and activation of operations review for services, configuration, credentials, schema, migrations, queues, deployment, or rollback.

### Lifecycle

Test cancellation, timeout, lease loss, stale owner, restart after every phase, logical-call budgets across retry, terminal-state fencing, and rollback compatibility.

Detailed contract: `docs/testing/agentic-worker-verification.md`.

## Architecture Lint additions

Enforce:

- role IDs and mode-permission mappings have one owner;
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

Account for pre-existing cleanup findings and prove none were introduced in changed files. Run lifecycle/concurrency-sensitive suites repeatedly and serially where isolation risk warrants it. Verify exact-head GitHub Actions checks.

## Live qualification

Use a disposable workspace to demonstrate:

- one CLI with per-role model selection;
- one-model degraded operation;
- requirements clarification and validation of a complete issue;
- rejected scan candidate;
- read-only scan followed by approved TDD implementation;
- documentation-only mutation enforcement;
- restart and cancellation without duplicate calls;
- accurate independent/non-independent review;
- rollback to legacy routing without queue or state corruption.

Production rollout is separately approved and is not implied by passing disposable qualification.