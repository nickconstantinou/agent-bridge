# Implementation Plan — Issue #159 Role-Based Agentic Orchestration

## Status

Approved epic implementation handoff for a sequence of coding-agent pull requests.

This document is not an instruction to implement Issue #159 in one branch. Each delivery slice must have its own linked child issue, isolated workspace, red and green commits, exact-head evidence, independent re-review, and human merge decision.

The accepted ADR and target-state documentation are normative. An implementation must not weaken the agreed architecture merely to fit the current worker code.

## Objective

Implement three configurable Engineering Worker roles:

- **Technical Lead** — requirements discovery and validation, canonical issue authoring, implementation planning, bounded executor guidance, implementation review, operations review, and PR readiness;
- **Code Worker** — read-only defect/refactor scanning and investigation, mechanically separated red/green implementation, bounded repair, and verification;
- **Documentation Steward** — documentation impact, documentation-only authoring, and documentation validation.

Feature, defect, and refactor work must move through validated requirements, an approved canonical GitHub issue, Technical Lead-authored planning, bounded Code Worker execution, deterministic verification, Technical Lead review, Documentation Steward completion, and the existing human merge/deployment gates.

Agent Bridge remains authoritative for state, permissions, evidence, role/model resolution, budgets, retries, cancellation, GitHub mutation, approvals, merge, deployment, and audit.

## Read first

- Issue #159;
- `AGENTS.md`;
- `docs/adr/ADR-005-role-based-agentic-orchestration.md`;
- `docs/agentic-maintenance.md`;
- `docs/architecture/engineering-worker.md`;
- `docs/architecture/agentic-worker-orchestration.md`;
- `docs/configuration/agent-role-assignment.md`;
- `docs/operations/agentic-worker-runbook.md`;
- `docs/testing/agentic-worker-verification.md`;
- `agentic-maintenance.yaml`;
- Issues #100, #119, #132, and #146;
- PR #157 and the implementation-plan validator it hardens;
- the linked `agent-bridge-platform` implementation issue created in Slice 0.

Use the repository requirements-to-acceptance, risk-based-test-strategy, red-green-refactor-TDD, release-readiness-review, and git-sandbox skills before editing.

# Working model

This plan represents the working method used by the maintainer and technical reviewer on Agent Bridge:

1. Do not assume the request or issue is complete.
2. Gather repository and runtime evidence before making architecture claims.
3. Surface product decisions instead of silently inventing them.
4. Turn intent into a clear issue with observable acceptance criteria before planning.
5. Put the strongest reasoning model on requirements, architecture, planning, risk, and review.
6. Give coding models bounded work packets rather than broad ownership of the solution.
7. Start each behavioural change with a production-boundary red test that fails for the intended reason.
8. Commit tests and implementation separately.
9. Deliver small, reviewable slices rather than one epic PR.
10. Perform independent review, fix findings, rerun exact-head checks, and perform a fresh final re-review.
11. Verify authoritative postconditions instead of relying on intended actions or model claims.
12. Use disposable qualification before any separately approved production rollout.
13. Preserve human authority over product decisions, merge, deployment, destructive operations, secrets, permissions, and policy exceptions.
14. End each non-trivial slice with a defect-pattern retrospective.

# Non-negotiable invariants

1. The public configurable role set is exactly `technical_lead`, `code_worker`, and `documentation_steward`.
2. Scanner is a Code Worker mode. Reviewer and operations are Technical Lead modes.
3. Role authority is independent of CLI/provider identity.
4. Technical Lead remains mutation-free and uses the existing authoritative `AdvisorService` boundary.
5. Code Worker permissions are mode-specific and Bridge-enforced.
6. Documentation Steward authoring is limited to manifest-approved documentation paths.
7. No implementation plan is created before `requirements_ready`.
8. No scan finding becomes implementation work without Technical Lead disposition and canonical issue approval.
9. Structured outputs are validated before persistence or use.
10. Models cannot override deterministic evidence or human gates.
11. Cancellation, ownership loss, restart, and retries cannot duplicate logical calls or overwrite terminal state.
12. Existing red/green commit separation, disposable workspaces, PR-head checks, CI gates, and merge approval remain intact.
13. Legacy chains are explicit compatibility inputs, not silent alternate authority.
14. Desired platform configuration is not presented as effective until the appliance reports the exact applied revision.
15. Invalid new configuration never destroys the last valid effective assignment.
16. GitHub mutations are performed by Agent Bridge, never by a model.
17. No new direct SQL, provider execution path, process supervisor, workflow state store, queue, or merge path is introduced.

# Minimal-change implementation strategy

The target architecture must be delivered as a **strangler extension of the existing worker**, not as a worker rewrite.

## Existing components to retain

Retain and extend:

- the current durable `work_items`, `work_jobs`, approvals, and GitHub-link repositories;
- the current handler map and registered task types;
- `jobExecutor` and `jobExecutorLoop` ownership, leasing, heartbeat, retry, cancellation, and terminal-state fencing;
- `orchestrated_task` as the initial role-orchestration host;
- `tdd_implementation` and its mechanical test-only/production-only commit guards;
- disposable workspace creation and cleanup;
- the existing CLI supervisor and child-process termination path;
- the provider adapter/capability registry;
- the existing `AdvisorService`, audit, fallback, redaction, and logical-call controls;
- the implementation-plan quality validator and PR #157 contract repair;
- current GitHub issue/PR helpers and merge gate;
- current Telegram worker commands, callback ownership, and captured-next-message pattern;
- existing configuration loader and env compatibility;
- current Architecture Lint ownership boundaries.

## Changes that are intentionally additive

Add:

- role and mode domain types;
- assignment/resolution repositories and additive migrations;
- a deterministic role resolver called by existing handlers;
- new work-item revision and human-decision records;
- role-aware phases inside the existing orchestrated lifecycle;
- typed read-only evidence grants through the existing advisor boundary;
- documentation phases in the existing implementation workspace;
- desired/effective role status projections;
- platform API/UI support through the existing bootstrap/status boundary.

## Explicit non-refactors

Issue #159 does **not** require:

- replacing the handler map with a new workflow engine;
- event sourcing the worker lifecycle;
- renaming or replacing existing task types;
- replacing SQLite;
- changing the queue claim/lease design except where Issue #119 already requires it;
- creating a model-to-model conversation loop;
- creating a separate scanner, reviewer, or operations service;
- replacing the current TDD handler;
- changing merge or production authority;
- moving platform code into the OSS repository.

## Compatibility path

Role routing is introduced behind a policy/version gate. Until a slice explicitly switches one phase:

- existing feature, defect, refactor, planning, implementation, verification, and PR flows continue unchanged;
- existing worker-chain configuration remains readable;
- persisted role assignments remain dormant;
- current jobs complete under the lifecycle semantics with which they started.

Each slice must include characterization tests proving unchanged sibling behaviour. A child issue may change only the specific phase it owns.

# Locked authority and product decisions

## Canonical issue ownership

GitHub is the visible requirements record. Agent Bridge retains source and revision history needed for validation and safe reconciliation.

Persist for every work item:

- immutable source snapshot and source type;
- source revision/hash;
- Technical Lead validation result and evidence references;
- each canonical issue revision;
- unresolved decisions and durable answers;
- approval/rejection of proposed revisions;
- GitHub issue number and last reconciled content hash.

Workflow:

1. Capture the source.
2. Technical Lead validates or gathers requirements through read-only tools.
3. Technical Lead proposes a canonical issue revision.
4. Material scope, acceptance, security, data, operations, rollout, compatibility, or non-goal changes require human approval.
5. Agent Bridge creates or updates the GitHub issue.
6. The approved revision becomes `requirements_ready`.
7. Later external GitHub edits create a new source revision and trigger revalidation; they do not silently replace the approved revision.
8. GitHub is authoritative for visible reconciled requirements. SQLite is authoritative for execution, revision lineage, decisions, calls, leases, and approvals.

## Human clarification and approval

Use existing worker surfaces:

- `/issue <id>` shows missing facts, unresolved decisions, proposed revision, evidence, and state;
- callbacks provide Approve, Request changes, Reject, and Approve split;
- free-text answers use the existing captured-next-message pattern;
- each answer records actor, timestamp, question ID, work-item revision, and redacted answer;
- restart restores the pending decision;
- split creates deterministic child candidates with source lineage and requires human approval before GitHub creation.

## Platform versus appliance authority

The platform owns desired role policy. The appliance owns authentication, model discovery/probes, effective resolution, degradation, applied revision, and runtime state.

Desired configuration revisions are monotonically increasing. The appliance validates and applies a revision atomically. Invalid or incompatible revisions are rejected while the last valid revision remains effective. Offline workspaces keep their last valid configuration. Heartbeat/status reports desired revision, applied revision, applied/degraded/rejected/pending state, effective targets, and validation errors.

Extend the existing bootstrap/status boundary. Do not create an unrelated configuration channel.

## Assignment precedence

1. explicit repository assignment;
2. explicit workspace assignment;
3. accepted recommended assignment;
4. automatic resolution;
5. explicitly enabled legacy-derived compatibility assignment.

An active role call snapshots its assignment revision, resolution revision, target, mode, permission profile, and risk policy. Re-resolve before a new role phase or retry, never during a successful provider attempt.

## Deterministic resolver

Filter out unauthenticated, disabled, unsupported, permission-incompatible, policy-blocked, over-budget, failed-probe, or stale-beyond-policy targets.

Technical Lead requires verified structured output and enforceable or Bridge-wrapped read-only execution. Manual model IDs require a successful bounded probe before first use.

Default freshness:

- authentication check: 5 minutes;
- model/capability probe: 24 hours;
- successful probe up to 7 days old may be used only as explicit degradation when no fresh target exists and risk policy allows it;
- failed probes are ineligible until a successful re-probe.

Use table-driven stable ranking tuples:

- Technical Lead: reasoning, structured-output reliability, read-only enforcement, context, review independence, cost, latency, lexical tie-break;
- Code Worker: coding, mode/tool compatibility, reliability, context, cost, latency, lexical tie-break;
- Documentation Steward: documentation, context, structured-output reliability, cost, latency, lexical tie-break.

Authentication, unsupported-model, and permission failures remove the target. Capacity/retryable failures move to the next configured eligible fallback. Malformed structured output receives at most one same-target repair before fallback. Manual assignments never use an unconfigured provider silently.

## Phase-aware budget defaults

| Phase group | Logical-call allowance |
|---|---:|
| requirements validation/discovery and issue authoring | 3 total |
| implementation planning | 1 |
| structural plan repair | 1 |
| executor guidance | 1 per blocked phase, 2 per task |
| implementation review | 1 |
| operations review | 1 when triggered |
| PR readiness | 1 |

A logical call may attempt at most two configured targets. Restart and fallback do not reset budgets. Duplicate idempotency keys reuse the durable result without spend. Platform policy may lower defaults but cannot raise hard repository limits without an approved policy change.

## Review independence

Preference:

1. different CLI and model from the implementing Code Worker;
2. different model on the same CLI;
3. configured Technical Lead target in a fresh session;
4. same target in a fresh session, marked non-independent.

Repository policy may require levels 1 or 2 for high-risk security, credential, permission, migration, destructive, or production work. If unavailable, hold for human decision.

## Documentation workspace and commits

Documentation Steward works in the same disposable implementation workspace after deterministic code verification.

Expected commit order:

1. red tests;
2. green implementation;
3. bounded code repairs;
4. documentation;
5. subsequent bounded repair commits only when review finds a defect.

The documentation commit may contain only manifest-approved documentation paths. A failure resumes from durable documentation state without discarding verified code commits. Documentation Steward cannot edit code or GitHub. A code defect found during documentation validation returns to Code Worker repair.

# Persistence and lifecycle

Use additive idempotent migrations and repository-owned SQL. Extend current repositories where ownership already fits; add focused repositories only where no current owner exists.

Required durable concepts:

- role assignments and assignment revisions;
- effective role resolutions;
- work-item source/canonical revisions;
- human decisions;
- role invocations and attempts;
- selected bounded results and evidence references;
- documentation impact/no-change records.

Uniqueness and idempotency:

```text
active assignment: workspace + optional repository + role
work-item revision: work-item + revision
role call: job + work-item revision + phase + role + mode + logical-call index
GitHub mutation: work-item + canonical revision + mutation kind
documentation phase: job + verified code head + manifest version
```

Repeated handling must resume or return prior durable output without duplicate spend, issues, updates, commits, or notifications.

Authoritative states:

```text
intake
requirements_gathering
human_decision_required
canonical_issue_proposed
canonical_issue_approval_required
requirements_ready
planning
plan_ready
execution
verification
technical_review
documentation
documentation_validation
pr_readiness
awaiting_merge_approval
completed
rejected
failed
cancelled
held
```

Keep these as role-orchestration phase data within the existing worker lifecycle initially. Do not replace the outer job status model. Existing `pending`, `running`, terminal, lease, retry, and cancellation semantics remain authoritative.

Terminal states cannot be overwritten. Permission reductions, auth revocation, cancellation, or lease loss fence late output immediately. Completed phases do not rerun after restart.

# Red-test protocol

Every child issue must list its exact red tests before implementation. “Add tests” is not sufficient.

## Required red-test description

For each red test record:

- test file and test name;
- production boundary under test;
- fixture/state setup;
- action performed through the real caller boundary;
- observable expected behaviour;
- why the current code must fail;
- expected failure assertion/message;
- focused command used to demonstrate red;
- sibling behaviour that must remain green.

## Red commit rules

- Commit tests before production implementation.
- The red commit may contain test files and test fixtures only, unless an additive migration fixture is mechanically necessary and contains no implementation behaviour.
- Run the smallest focused command and confirm the new test fails for the expected missing behaviour, not syntax, fixture, timeout, import, or unrelated failure.
- Existing tests must remain green except where a deliberately changed contract is captured by the new red test.
- Do not weaken, skip, delete, or rewrite unrelated tests.
- Do not duplicate production schemas, parsers, ranking logic, transition logic, or permission logic inside the test oracle.
- Prefer observable persisted state, emitted calls, filesystem/Git results, provider invocations, status projections, and user-visible callbacks.
- Helper-only tests are insufficient when correctness depends on handler wiring, repositories, lifecycle ownership, child-process environment, or GitHub projection.
- Characterization tests that lock existing behaviour should be committed green before the behavioural red commit and must not be represented as the red proof.

## Green commit rules

- Implement the smallest production change that satisfies the red boundary.
- The green commit must not modify the committed red tests unless the original test was proven incorrect and the correction is independently reviewed.
- Preserve existing sibling task types, commands, provider paths, and lifecycle behaviour.
- Run the focused test, affected subsystem suite, full suite, typecheck, Architecture Lint, cleanup/static checks, and `git diff --check` as required by risk.

# Delivery slices and comprehensive red-test catalogue

Create linked child issues for the following slices. Do not start Slice 1 until Slice 0 decomposition is approved.

## Slice 0 — Current-state reconciliation and child issues

Scope: documentation and issue work only.

Deliver:

- exact owner map after current open/merged work;
- child issues for Slices 1–10;
- linked platform issue and cross-repository schema plan;
- exact target files and dependencies;
- no production changes.

No behavioural red test. Verification is a repository evidence review proving the plan references current owners and does not duplicate active work.

## Slice 1 — Role domain, persistence, and dormant status

Minimal change: add domain/repository/config support; do not route any existing job through roles.

Required red tests:

1. **Exactly three roles**
   - Boundary: public config/domain parser.
   - Action: parse valid and invalid role assignments.
   - Current failure: role schema does not exist.
   - Red assertion: valid three roles accepted; scanner/reviewer/operations rejected.

2. **Additive migration and restart persistence**
   - Boundary: real `BridgeDb` migration plus role repository.
   - Action: migrate a representative current DB, persist assignments, reopen DB.
   - Current failure: tables/repository absent.
   - Red assertion: assignments and revisions survive reopen without altering existing jobs.

3. **Precedence and no silent legacy override**
   - Boundary: config-to-repository status projection.
   - Action: seed explicit assignment plus conflicting legacy chains.
   - Current failure: worker chains remain sole authority.
   - Red assertion: explicit assignment is reported authoritative; legacy source remains visible but inactive.

4. **Dormant compatibility**
   - Boundary: existing feature/defect/TDD handler invocation.
   - Action: run existing jobs with role-routing flag disabled and seeded role rows.
   - Current failure expected only for the new assertion that role rows are ignored safely.
   - Green requirement: prior provider selection and output remain byte/behaviour compatible.

## Slice 2 — Capability discovery and deterministic role resolution

Minimal change: extend provider metadata and add a resolver facade. Do not change handler routing yet.

Required red tests:

1. one authenticated CLI exposes different selected models for all three roles;
2. one model serves all roles while status reports lost diversity and independence;
3. unauthenticated/failed-probe/permission-incompatible targets are excluded;
4. stale probe uses explicit degraded state only within policy;
5. stable table-driven ranking and lexical tie-break produce deterministic output;
6. manual assignment never falls back to an unconfigured provider;
7. capacity failure advances to configured fallback while auth failure removes target;
8. malformed structured output receives one repair then fallback;
9. existing provider fallback for interactive and legacy worker jobs is unchanged while role routing is disabled.

Each test must assert the selected `provider:model`, resolution reason, degradation flags, and absence of secrets.

## Slice 3 — Mode permission enforcement

Minimal change: resolve a permission profile immediately before existing dispatch and reuse current workspace/supervisor/environment controls.

Required red tests:

1. Technical Lead invocation cannot write a file, invoke mutable Git, mutate GitHub, or receive service/production credentials;
2. Code Worker scan/investigate cannot leave a dirty worktree;
3. Code Worker red can stage/commit test files only and must demonstrate failing verification;
4. Code Worker green cannot modify committed red tests;
5. repair cannot modify paths outside the approved packet;
6. verify fails if the invocation changes the tree;
7. Documentation Steward author rejects `src/**`, `test/**`, scripts, services, packages, and any denied path even when a broad allow glob matches;
8. child processes receive no broader credentials than the invocation profile;
9. timeout, cancellation, and lease loss revoke capability immediately;
10. current TDD mechanical guards remain unchanged and green for existing jobs.

Use real temporary workspaces and Git status/diff assertions; do not test only the resolver helper.

## Slice 4 — Requirements validation and canonical GitHub issue workflow

Minimal change: add intake phases around existing work items and GitHub helpers. Do not change implementation handlers.

Required red tests:

1. a detailed imported issue still receives Technical Lead validation but reaches ready without unnecessary questions;
2. an ambiguous feature pauses with durable human decisions and no plan job;
3. a defect separates observed facts from root-cause hypotheses and requires regression evidence;
4. a refactor justified only by “cleaner” is rejected;
5. a scan finding remains a candidate and cannot queue implementation;
6. revise, clarify, split, reject, and ready verdicts produce exact states;
7. approved canonical revision is created/updated on GitHub by Bridge exactly once;
8. a material canonical rewrite requires human approval;
9. an external GitHub edit after approval creates a new source revision and triggers revalidation;
10. restart preserves pending questions and callbacks without duplicate advisor calls or GitHub mutations;
11. split creates deterministic child lineage and no duplicate issues on retry;
12. all existing `/issues`, `/issue`, approval, and captured-message behaviour remains green.

Use a focused fake GitHub boundary at the existing helper seam, not copied issue logic.

## Slice 5 — Bounded Technical Lead tools and advisor-authored planning

Minimal change: extend the existing `AdvisorService`; retain current plan validator and PR #157 repair path.

Required red tests:

1. requirements/planning can list and read allowlisted repository files with count/size/context limits;
2. path traversal, symlink escape, unrestricted shell, provider-native tool requests, and mutation attempts are rejected;
3. Git history/diff/status are available only through typed bounded commands;
4. evidence records include authority, freshness, scope, truncation, and capture time;
5. cancellation/lease loss during tool use prevents selected advice persistence;
6. planning cannot start before `requirements_ready`;
7. plan traces every acceptance criterion to a bounded packet and verification;
8. plan contains red/green steps, documentation impact, operations/rollback, escalation, and valid execution contract;
9. structurally invalid plan receives one repair and is revalidated;
10. required planning failure fails closed;
11. scribe fallback is used only when explicitly enabled, audited, and marked degraded;
12. existing AdvisorService fallback, audit, redaction, and budget tests remain green;
13. existing legacy plan path remains unchanged while role-planning flag is disabled.

## Slice 6 — Code Worker scan and bounded execution packets

Minimal change: adapt current scan outputs and feed approved packets into the existing TDD/orchestrated handlers.

Required red tests:

1. defect and refactor scans run read-only and return evidence-rich candidates;
2. candidates cannot directly enqueue TDD implementation;
3. Technical Lead ready/reject/combine/split/request-evidence dispositions create exact next state;
4. split disposition is idempotent;
5. an approved plan persists immutable packet scope;
6. red, green, repair, and verify attempts cannot expand packet paths or acceptance criteria;
7. executor evidence records exact commits, commands, results, changed paths, and residual risk;
8. one bounded guidance retry is allowed; a second blocked outcome holds for human input;
9. retry/restart resumes the packet without duplicate red or green commits;
10. existing `tdd_implementation` red/green guard, workspace cleanup, and PR creation tests remain green.

## Slice 7 — Documentation Steward lane

Minimal change: add phases to the existing implementation workspace and PR lifecycle; do not create a separate repository mutation service.

Required red tests:

1. planning creates a structured documentation-impact record;
2. final trigger evaluation uses the verified diff rather than the initial plan alone;
3. manifest triggers deterministically require the correct document classes;
4. authoring creates a separate docs commit after the green code commit;
5. the docs commit contains only allowed paths;
6. denied-path precedence blocks code/test/script/service/package changes;
7. missing required documents blocks PR readiness;
8. `no_documentation_change` requires rationale, trigger evidence, and Technical Lead validation;
9. documentation validation detects contradiction with final configuration, behaviour, architecture, or runbook evidence;
10. a code defect discovered during docs validation returns to bounded Code Worker repair;
11. docs retry resumes without discarding verified code commits or duplicating commits;
12. fallback target receives identical documentation-only permissions.

## Slice 8 — Technical Lead implementation and operations review

Minimal change: add review phases after current deterministic verification; do not add a reviewer service.

Required red tests:

1. review cannot run before deterministic verification passes;
2. failed tests/typecheck/Architecture Lint cannot receive ready verdict;
3. different target preference follows the exact four-level order;
4. reused target starts a fresh isolated session;
5. non-independent review is visibly recorded;
6. high-risk policy holds when required independence is unavailable;
7. operations review triggers for service, deployment, config, credential, schema, migration, queue, lifecycle, backup, and rollback changes;
8. operations output requires prerequisites, sequence, abort conditions, rollback, authoritative postconditions, and residual risk;
9. Technical Lead cannot merge, deploy, restart, or mutate configuration;
10. existing human merge approval and PR-head/CI checks remain the sole merge path.

## Slice 9 — Lifecycle, audit, compatibility, and rollout gate

Minimal change: extend current phase data, ownership fencing, and audit. Do not replace outer job status or queue semantics.

Required red tests:

1. restart after every role phase resumes at the next incomplete phase;
2. duplicate idempotency keys do not spend budget or duplicate effects;
3. cancellation during provider output or tool use fences late persistence;
4. lease loss/stale owner cannot commit output or overwrite terminal state;
5. task-wide logical-call and repair budgets survive restart;
6. assignment changes apply only at the next phase/retry and preserve prior lineage;
7. authentication revocation or permission reduction fences immediately;
8. migration from representative current DBs is additive and preserves queued/in-flight/completed jobs;
9. role routing disabled preserves current worker behaviour;
10. rollback retains assignments/audit but holds states unsafe for legacy interpretation;
11. no new queue, supervisor, state store, or direct SQL path exists;
12. serial and repeated suites expose no isolation or duplicate-call race.

## Slice 10 — Platform desired/effective role allocation

Repository: `agent-bridge-platform`, with linked OSS compatibility evidence.

Required red tests:

1. API accepts only the three roles, explicit models for manual assignments, ordered fallbacks, bounded budgets, and valid permission-compatible targets;
2. desired revisions are monotonic and stale writes are rejected;
3. bootstrap delivers exact desired revision and schema version;
4. heartbeat distinguishes desired from applied revision and applied/degraded/rejected/pending status;
5. invalid appliance application leaves the last valid effective assignment visible;
6. offline workspace continues last known effective configuration;
7. UI supports Automatic, Recommended, and Manual modes;
8. UI visibly reports authentication, probe freshness, effective target, model diversity, review independence, and degradation;
9. one CLI and one model configurations remain usable;
10. role test action is non-mutating and does not expose credentials;
11. raw provider credentials are not persisted in role-assignment records;
12. older appliance/platform schema incompatibility is explicit and fail-safe;
13. platform never claims desired state is effective before matching heartbeat evidence.

# Cross-repository rollout

1. Merge OSS schema/parser/status support with routing disabled.
2. Qualify additive OSS migrations and unchanged legacy flow.
3. Merge platform read-only effective-status support.
4. Merge platform desired configuration API/UI behind a disabled flag.
5. Deploy OSS compatibility before the platform issues role revisions.
6. Enable a disposable workspace.
7. Run the full single-CLI, single-model, multi-provider, invalid-config, offline, cancellation, restart, migration, rollback, documentation, review, and PR-readiness scenarios.
8. Enable selected beta workspaces only after explicit approval.
9. Production-wide enablement and legacy-chain retirement require separate approval and evidence.

Rollback stops new desired revisions, disables role routing, retains all records, uses only explicitly approved legacy compatibility, and holds incompatible new-state jobs rather than reinterpreting them.

# Verification requirements

For every child PR:

- focused red command and captured expected failure;
- focused green command;
- affected subsystem suite;
- full `npm test`;
- `npm run typecheck`;
- `bash scripts/arch-lint.sh src`;
- `npm run cleanup:check` with pre-existing findings accounted for;
- `git diff --check`;
- exact final head and exact-head CI;
- repeated and serial runs when lifecycle, concurrency, leases, cancellation, or shared state changed;
- final diff audit for unrelated changes;
- sibling role/provider/task/transport audit;
- documentation-trigger evaluation;
- retrospective result.

Before merge readiness:

1. perform an independent review against the child issue and this plan;
2. fix every blocker without weakening the contract;
3. rerun focused and broad checks at the new exact head;
4. perform a fresh final re-review;
5. report what was tested, what was not tested, and residual risk;
6. leave the PR draft until the maintainer decides it is ready.

No production deployment, service restart, database mutation, or platform rollout occurs without separate explicit approval.

# Execution contract

```json
{
  "delivery_model": "epic_with_linked_child_issues_and_reviewable_prs",
  "implementation_strategy": "strangler_extension_of_existing_worker",
  "retained_boundaries": [
    "existing work item and job repositories",
    "job executor loop, leases, cancellation, and terminal fencing",
    "orchestrated_task host lifecycle",
    "tdd_implementation mechanical red/green guards",
    "disposable workspace and CLI supervisor",
    "provider registry and AdvisorService",
    "implementation plan validator and bounded repair",
    "GitHub PR lifecycle and human merge gate"
  ],
  "new_capabilities": [
    "three role domain and assignment resolution",
    "requirements and canonical issue revisions",
    "typed Technical Lead evidence",
    "advisor-authored plans and bounded execution packets",
    "documentation steward phases",
    "desired versus effective platform role configuration"
  ],
  "red_test_requirement": "Every behavioural child issue enumerates production-boundary red tests including setup, action, expected observable result, why current code fails, focused command, and sibling behaviour that remains green.",
  "commit_requirement": "Characterization if needed, then test-only red commit, separate minimal green implementation commit, bounded repairs, and separate documentation commit.",
  "verification_requirement": "Focused and full tests, typecheck, Architecture Lint, cleanup/static checks, git diff check, exact-head CI, lifecycle repetition/serial qualification where relevant, independent review, fixes, and fresh final re-review.",
  "risk_level": "high",
  "human_gates": [
    "child issue decomposition",
    "material requirements decisions",
    "canonical issue material changes",
    "role defaults and risk policy",
    "merge",
    "production deployment or restart",
    "secret, permission, destructive, or policy change"
  ],
  "out_of_scope": [
    "worker rewrite",
    "new workflow engine as a prerequisite",
    "new queue, supervisor, or state store",
    "event sourcing migration",
    "separate scanner, reviewer, or operations role",
    "unrestricted model-to-model loop",
    "automatic merge or deployment",
    "removal of current fail-closed validation before replacement qualification"
  ]
}
```

# Completion criteria

Issue #159 is complete only when:

- all linked OSS and platform child issues are complete;
- exactly three roles are configurable;
- existing worker flows remain behaviourally compatible except where an approved child issue intentionally changes a phase;
- every new phase is protected by the red tests listed above and corresponding focused tests;
- canonical issue, planning, execution, review, operations, documentation, and role-resolution contracts are durable and restart-safe;
- single-CLI and single-model operation is qualified with explicit degradation;
- migration and rollback are demonstrated against representative current state;
- target-state documentation matches delivered behaviour;
- exact-head CI and required disposable qualification pass;
- an independent final review finds no unresolved blocker;
- the retrospective records `no new systemic pattern`, `existing rule covers it`, or a linked justified rule/skill follow-up.