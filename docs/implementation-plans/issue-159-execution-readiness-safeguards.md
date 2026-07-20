# Issue #159 Addendum — Execution and Human-Review Readiness Safeguards

## Status and authority

Normative process addendum for Issue #159 and every behavioural child slice.

This addendum supplements the canonical role-orchestration implementation plan, prompt/red-test contract, operations runbook, verification contract, production-readiness checklist, and `agentic-maintenance.yaml`. Where older prose permits implementation to continue without executable red evidence, stacked exact-head CI, guarded issue mutation, trigger-bounded documentation, or the required Technical Lead review lane, this addendum is authoritative.

It changes process safeguards only. It does not activate role routing, add product scope, authorize merge or deployment, or weaken any human gate.

## 1. Execution-capable preflight

Before any behavioural test or production mutation, Agent Bridge must prove:

- a clean isolated worktree exists;
- the checkout is not a live or production checkout;
- the exact base, branch and head are resolved;
- locked dependencies can be installed;
- required repository tools and commands are available;
- the focused red command is executable;
- a read-only Technical Lead review lane is available for the final exact-head review.

A connector-only or static-inspection environment may gather evidence and author a plan, but it may not progress into red, green, repair, verification, documentation completion or readiness for behavioural work.

A failed, unavailable, stale or unproven preflight stops before mutation. The missing capability is a blocker, not a task to defer until after implementation.

## 2. Observed red before green

Green implementation requires authoritative observed-red evidence from the exact committed red state.

The evidence must show:

- the focused red command actually ran;
- the intended assertion failed for the documented missing behaviour;
- syntax, imports, fixtures, dependencies, timeout, baseline and unrelated failures were excluded;
- required sibling characterization remained green;
- the red evidence has not been invalidated by rewriting the red commit or changing its dependencies.

Authored tests, static review, an expected failure, or a command marked `not_run` do not satisfy the red gate.

When red and green are no longer at the same repository state, historical red proof runs in a disposable detached worktree at the exact red commit. A red commit that fails for the wrong reason is a TDD defect and requires human-visible correction; published history must not be silently rewritten.

## 3. Stacked pull-request CI

The repository CI workflow supports:

- pull requests targeting any base branch;
- explicit `workflow_dispatch` for an exact selected ref;
- the existing `main` push path.

Every behavioural stacked PR requires exact-head Test & Typecheck and Architecture Lint. An intentionally stacked base does not waive CI.

When a foundation change moves a stacked base, every dependent slice must reconcile its exact base and rerun all head-bound verification, review, documentation and readiness phases invalidated by the move.

`passed`, `failed`, `not_run`, `not_scheduled`, `stale` and `unknown` remain distinct. Only authoritative `passed` evidence for the exact current head satisfies a required gate.

## 4. Independent Technical Lead review

The final independent review is a Technical Lead responsibility performed through the read-only AdvisorService path.

Independence is established by role and authority separation:

1. the reviewer acts in the `technical_lead` role;
2. the reviewer did not author or modify the implementation under review;
3. the review invocation has no mutation authority;
4. the reviewer performs a fresh review of the exact checked `subject_head_sha`.

Issue #161 adds a genuinely independent frontier requirement to the role/authority controls above. A same-model fresh session is `non_independent`. Prior read-only requirements, planning, decomposition, guidance, implementation-review, or operations advice does not disqualify an otherwise independent Technical Lead from performing the final review.

The mutating Code Worker cannot review its own implementation. A fresh invocation is required after any head change or blocker repair. The Technical Lead reports its role, target, model identity, lack of mutation authority, whether it changed the reviewed code, and the exact reviewed head.

The final review applies to the exact checked head. Any blocker correction invalidates the applicable downstream evidence and requires a fresh Technical Lead review invocation.

## 5. Guarded GitHub issue mutation

Model output is candidate content, not evidence that GitHub mutation succeeded.

Before updating an existing issue, Agent Bridge must:

1. retain the exact current body and revision or stable hash;
2. compare the expected current revision immediately before writing;
3. perform a guarded update;
4. refetch the stored issue;
5. semantically validate that approved requirements, invariants, acceptance criteria, evidence, non-goals, dependencies and human gates remain present and unchanged except for the approved mutation.

For multi-issue work, the same procedure follows the accepted bundle-wide decomposition verdict for every child issue.

A conflict, connector error or failed post-write validation blocks the workflow. Do not reconstruct a lost issue body from memory. Restore from retained authoritative content or request human recovery.

## 6. Trigger-bounded documentation

Same-delivery correction of stale required documentation remains mandatory. That requirement does not authorize unrelated document redesign.

Documentation authoring must map each changed section to an approved manifest trigger. Prefer the smallest correction that makes the authoritative document current.

A broad rewrite is allowed only when the complete document is demonstrably stale or inconsistent and the whole replacement is revalidated against:

- current code and public interfaces;
- commands and defaults;
- configuration and service ownership;
- deployment and operational procedures;
- rollback and recovery;
- current versus planned behaviour.

Marketing-only changes, opportunistic restructuring, removal of still-current operational content, or any unrelated/unproven rewrite block readiness.

## 7. Canonical phase and invalidation order

The runtime order remains:

```text
deterministic verification
→ Technical Lead implementation review
→ Technical Lead operations review when triggered
→ Documentation Steward authoring and validation
→ Technical Lead PR readiness
→ exact-head CI
→ final exact-head Technical Lead review
→ human merge gate
```

Code-changing repair invalidates verification, implementation review, operations review, documentation, readiness, exact-head CI and final Technical Lead review for the previous head.

Moving the stacked base or rewriting a red commit also invalidates evidence whose repository state or assumptions changed.

## 8. Human-review-ready definition

`READY FOR HUMAN REVIEW` is permitted only when one exact final head has:

- a passed execution preflight;
- valid observed-red evidence for every required behavioural red test;
- passed focused, subsystem, full-suite, typecheck, Architecture Lint, cleanup/static and diff checks;
- passed migration, rollback, repeated or serial qualification when triggered;
- passed exact-head stacked-PR Test & Typecheck and Architecture Lint;
- accepted implementation and operations review;
- trigger-bounded current documentation, or a fully revalidated necessary broad rewrite;
- verified GitHub issue-mutation integrity when issues were changed;
- a fresh exact-head read-only Technical Lead final review independent from the mutating Code Worker;
- current and accurate PR/issue evidence;
- a clean worktree and no unresolved blocker.

A required check or review that is `not_run`, `not_scheduled`, `stale`, `unknown`, unavailable, incomplete or deferred makes the verdict `NOT READY FOR HUMAN REVIEW`.

## 9. Retrospective feedback

Every non-trivial slice reports evidence-backed process feedback covering:

- defects or ambiguity in prompts, skills, orchestration or documentation;
- execution or review capabilities that were unavailable;
- false-positive or helper-only test weaknesses;
- unsafe mutation or evidence-handling incidents;
- documentation scope drift;
- corrections required for the current delivery;
- reusable recommendations for later slices.

Corrections required for current correctness or readiness are implemented and validated in the same delivery. `AGENTS.md` changes remain reserved for demonstrated recurring systemic patterns not already covered by existing policy.
