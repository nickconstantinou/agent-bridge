# Agentic Worker Verification Contract

## Status

Canonical verification requirements for role-based Engineering Worker orchestration. Slice 1 activates only the exact role domain, desired assignment validation and persistence, schema-version-3 migration, and truthful dormant status. The complete later-slice requirements remain normative as each owning Issue #159 slice activates its behaviour.

## Test principles

- Write boundary-level acceptance tests before implementation.
- Preserve red-green-refactor with separate red and green commits for behaviour changes.
- Test authoritative state and externally observable effects rather than model wording.
- Treat issue mutation, permission, lifecycle, persistence, role resolution, prompts, canonical skills, structured output, exact-head evidence, and documentation triggers as risk boundaries.
- Require Technical Lead plans to define comprehensive red tests protecting product and architectural intent.
- Keep reusable SDLC know-how authoritative in versioned repository skills rather than copied prompt passages.
- Deterministic evidence overrides model claims.
- A stale required document or stale exact-head result is a failed readiness condition, not a deferred follow-up.

## Slice 1 acceptance suites

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

Slice 1 does not claim capability availability, model suitability, or permission suitability. Those belong to later resolution tests.

### Schema 2 to 3 migration and repository persistence

Use the existing schema registry, numbered migration boundary, repository SQL ownership, and `BridgeDb` façade. Cover:

- exact prior schema version 2 fixture creation through registered migrations 1 and 2;
- transactional migration to schema version 3;
- exact role-table shape and foreign keys;
- preservation of representative work items, jobs, approvals, GitHub links, advisor calls, and conversation turns;
- zero `foreign_key_check` violations;
- close/reopen persistence;
- current-revision lookup and ordered history;
- identical retry returns the same revision without a duplicate row;
- reused idempotency identity with changed input fails deterministically;
- persisted columns and values exclude credentials, prompts, and repository content;
- any pre-existing role-assignment table at schema version 2 causes rollback, preserves existing rows and version 2, and leaves no partial sibling table;
- fresh and legacy migration suites continue to reach the declared current version.

### Guarded rollout qualification

Cover:

- the rollout inspector permits both role tables and no unrelated unknown table;
- an exact schema-version-2 database with current legacy queue/lock shape is `migratable`, not `current`;
- migration produces schema version 3 with both role tables;
- validation reports `current` only for exact schema version 3 plus required queue, lock, and role-table shape;
- queue counts, hashes, integrity, backup, and rollback behaviour remain owned by the existing guarded-helper tests.

### Dormant status and dispatch compatibility

Cover:

- `/chain` preserves its exact legacy-only response when no role revision exists;
- configured desired assignments are reported as `configured_dormant`;
- desired revision, source, primary, and fallback targets are visible without secrets;
- status states `Role routing: disabled`;
- status reports effective legacy interactive, code, and scribe chains;
- `resolveWorkerCliPolicy()` is identical with or without role-assignment environment values;
- real durable job claim, execution, completion, and result persistence cover `defect_scan`, `feature_plan`, `implementation_plan`, `tdd_implementation`, `orchestrated_task`, `open_github_issue`, and `pr_lifecycle`;
- the production handler-map fixture proves those task types remain on the existing scribe, code, command, Git, and GitHub owners;
- no handler-map code references role assignment, capability resolution, or `configured_dormant` to select execution;
- no role invocation, role audit, or alternative routing side effect occurs.

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

Add all existing config, worker-command, worker-policy, database strict-open, and handler tests affected by the actual diff. Run lifecycle-sensitive migration and rollout tests serially or repeatedly where the repository contract requires it.

## Later active-role acceptance suites

### Role configuration

Cover:

- exactly three externally configurable role IDs;
- explicit CLI and model persistence;
- automatic, recommended, and manual selection;
- ordered fallback;
- invalid or unavailable model rejection;
- configuration-source projection;
- legacy chain compatibility precedence;
- no secret values in status or audit.

### Single-provider and single-model behaviour

Cover:

- one CLI exposing multiple models assigns each role independently;
- one model can serve every role with separate sessions, prompts, validators, and permission profiles;
- model-diversity and independent-review flags are accurate;
- repository policy can block high-risk work when independent review is required;
- required and actual independence are recorded separately;
- a fresh same-model session is not reported as independent.

### Requirements intake and multi-issue decomposition

For feature, defect, and refactor paths, cover:

- incomplete input cannot reach planning;
- apparently complete GitHub and local issues still receive validation;
- repository facts are gathered without asking the user unnecessarily;
- unresolved product decisions pause for human input;
- issue validation verdict schemas reject malformed output;
- canonical issue versions and `requirements_ready` transitions are durable;
- restart and retry do not duplicate validation calls.

For split or multi-issue work, additionally cover:

- every proposed child issue is assembled before GitHub mutation;
- `technical_lead:decomposition_review` receives the complete bundle;
- implementation delivery order and runtime phase order are represented separately;
- one invariant matrix covers owners/callers, lifecycle/state authority, permissions, schema/SQL, GitHub mutation, platform/appliance authority, compatibility, repair invalidation, and prohibited duplicates;
- a contradiction in any child issue returns `revise_bundle` and produces zero GitHub mutations;
- duplicate or overlapping scope blocks mutation;
- unresolved product policy returns a human-decision verdict;
- retries after a remote/local interruption remain idempotent.

### Scan candidate handling

Cover:

- Code Worker scans run read-only;
- defect and refactor findings remain candidates;
- every supported Technical Lead disposition;
- duplicate, rejected, and split findings do not accidentally queue implementation;
- split findings return to bundle review before child issue mutation;
- a refactor without concrete evidence or measurable benefit is rejected;
- scan output cannot grant mutation permission.

### Technical Lead boundary

Cover:

- every mode uses the existing authoritative advisor service;
- only typed, allowlisted, bounded read-only tools are available;
- tool path, size, count, timeout, and evidence budgets are enforced;
- output contracts are mode-specific and structurally validated;
- bounded repair is revalidated before persistence;
- malformed or unavailable required output fails closed;
- no shell, file mutation, GitHub mutation, merge, deploy, secret, or service capability is reachable.

### Prompt registry, lifecycle skills, and source isolation

Cover:

- every role/mode resolves exactly one registered prompt key and contract version;
- requirements, issue, decomposition review, planning, focused repairs, review, operations, guidance, Code Worker, and Documentation Steward prompts remain separate;
- every role/mode and compatibility prompt declares an ordered lifecycle-skill set explicitly;
- each canonical skill has exactly one marked runtime-guidance block and a matching `skill.json` name/version;
- requirements, risk-based testing, TDD, and release-readiness know-how comes from canonical skills rather than duplicated prompt supplements;
- missing, duplicate, empty, oversized, malformed, or version-mismatched guidance fails closed;
- fallback targets preserve prompt key/version, schemas, validator, role-template hash, skill identities, skill-set hash, and composed-template hash;
- changing one prompt does not change sibling prompt-template hashes or contracts;
- changing one skill changes only consuming prompts' skill-set, composed, and rendered hashes;
- every canonical prompt declares required render variables and missing inputs fail closed;
- supplied context is bounded before rendering;
- canonical and compatibility prompts resolve only from registered source-controlled files and report `source: builtin`;
- database prompt table accessors, loader overrides, and handler reads remain absent;
- schema migration 2 drops an absent or empty legacy table transactionally;
- an unexpected populated table fails closed and preserves schema version 1 plus its rows;
- prompt and lifecycle-skill identities remain audit-safe without raw repository context.

Canonical contract: `docs/architecture/agentic-prompt-contracts.md`.

### Planning and target provenance

Cover:

- planning requires `requirements_ready`;
- plans trace every acceptance criterion;
- execution contracts include bounded work packets, red/green phases, verification, documentation, and operations obligations;
- every new or repaired plan's target path is classified as `existing_at_base`, `existing_in_dependency`, `proposed_new_production`, or `proposed_new_test`;
- each target has an owner and rationale;
- dependency-owned paths require a dependency PR and exact reviewed ref;
- proposed production files identify their neighbouring owner and why no existing path is sufficient;
- invalid or unclassified targets fail plan validation;
- already-persisted pre-provenance plans may use only the narrow concrete-path compatibility validator;
- generated or repaired model output can never use that compatibility path;
- legacy scribe output cannot silently become the canonical plan when role routing is authoritative;
- current focused execution-contract repair remains separate until replacement is complete.

Every valid Technical Lead plan also contains structured comprehensive red-test specifications. Cover:

- every acceptance criterion maps to red tests or a justified deterministic non-test proof;
- affected product behaviour and architectural boundaries/invariants are explicit;
- each red test identifies file/name, real production boundary, fixture/state, caller action, observable result, current failure, expected red assertion, focused command, oracle, false-positive controls, and sibling behaviour remaining green;
- architecture/refactor work includes characterization and structural/Architecture Lint coverage where applicable;
- lifecycle work triggers cancellation, retry, restart, lease, stale-owner, race, and terminal-state coverage as applicable;
- permission/security work triggers deny-path and credential-isolation coverage;
- operational work triggers abort, rollback, and authoritative postcondition coverage;
- generic instructions fail validation;
- helper-only tests fail validation when production wiring matters;
- cited existing tests identify exact file/test and prove sufficiency;
- red-test specifications survive restart without semantic drift.

### Focused plan repair

Cover:

- inadequate red-test sections use only `technical_lead:planning_repair:red_tests`;
- missing execution contracts use only the separate execution-contract repair key;
- red-test repair can replace only red-test and coverage fields;
- attempted scope, non-goal, packet, architecture, permission, operation, or human-gate changes are rejected;
- new or repaired plans must satisfy strict target provenance;
- one repair is allowed and the full plan is revalidated;
- multiple substantive invalid sections fail rather than chaining autonomous repairs;
- failure after bounded repair is fail-closed.

### Code Worker permission modes

Cover:

- scan/investigate cannot mutate files or Git;
- red can commit test files only and must demonstrate the exact planned failure;
- red receives the validated `RedTestSpec`, not free-form strategy ownership;
- green cannot alter committed red tests;
- repair cannot escape the approved packet;
- verify cannot introduce source changes;
- permission tokens are invocation-scoped and revoked on completion, cancellation, timeout, or lease loss.

### Review, operations, and exact-head evidence

Cover:

- implementation review cannot run before deterministic verification;
- implementation review does not consume completed documentation;
- operations review follows accepted implementation review and precedes documentation;
- Documentation Steward authoring requires accepted implementation and applicable operations review for the same `subject_head_sha`;
- readiness requires verification, review, operations, documentation, and CI evidence for the same current head;
- gate status distinguishes `passed`, `failed`, `not_run`, `not_scheduled`, `stale`, and `unknown`;
- only authoritative `passed` evidence for the current head satisfies a required gate;
- `not_scheduled` or `not_run` cannot be reported as green;
- different-target review preference follows policy;
- required and actual independence are recorded separately;
- unavailable required independence holds for human decision;
- model verdict cannot mark failed, missing, stale, or moved-head evidence ready;
- a code-changing repair invalidates verification, review, operations, documentation, and exact-head CI evidence for the previous head.

### Documentation Steward and no-deferral policy

Cover:

- impact and validation are read-only;
- author mode can change only manifest-approved documentation paths;
- production-code and test-code mutations are rejected;
- manifest triggers resolve required documents deterministically;
- `docs/architecture/01-current-architecture.md` is included in canonical architecture coverage;
- a `no_documentation_change` result requires rationale, trigger evaluation, and Technical Lead validation;
- missing, stale, contradictory, or materially misleading required documents make readiness impossible;
- a later issue, owner assignment, archive suggestion, or follow-up does not satisfy readiness;
- required documentation is corrected and revalidated in the same delivery;
- scope expansion needed for a required correction returns a human-scope hold rather than a ready verdict.

### Lifecycle and persistence

Cover:

- cancellation prevents new role calls and fences late output;
- terminal states cannot be overwritten;
- restart resumes from authoritative phase state;
- lease loss prevents duplicate calls and persistence;
- logical-call budget is preserved across retries and restart;
- completed phases are not rerun;
- stale model probes are revalidated before new calls;
- prompt contract, role-template hash, skill identities, skill-set hash, composed-template hash, and rendered hash remain bound to each durable logical call;
- rollback to legacy routing preserves new records without unsafe reinterpretation.

## Structural checks

Architecture Lint should enforce or be supplemented by tests proving:

- role IDs, modes, and permission profiles have central owners;
- role-assignment SQL remains in one repository behind `BridgeDb`;
- configuration and status owners contain no role-assignment SQL;
- current handlers do not route through dormant role assignments;
- one prompt-contract registry owns role/mode metadata;
- one lifecycle-skill registry owns extraction, versions, budgets, and composition;
- worker handlers do not invoke provider CLIs directly for later role work;
- Technical Lead calls route through the advisor boundary;
- full planning and focused repairs use different keys;
- prompts and skills cannot own tool, permission, budget, or lifecycle authority;
- canonical prompt loading cannot depend on database prompt storage;
- duplicated canonical lifecycle passages are not reintroduced;
- documentation-only handlers cannot import production mutation helpers;
- role audit SQL remains in its repository;
- role status handlers remain read-only.

## Required deterministic evidence

Final evidence includes:

```text
complete focused suite for the implemented slice
full test suite
npm run typecheck
bash scripts/arch-lint.sh src
npm run cleanup:check or documented pre-existing findings
git diff --check
changed-path and unexpected-file audit
clean isolated worktree status
exact-head GitHub Actions checks
```

Each check or workflow is recorded separately as `passed`, `failed`, `not_run`, `not_scheduled`, `stale`, or `unknown`. A partial workflow must not be summarized as “CI passed.” Migration work additionally runs upgrade, reopen, idempotency, failure rollback, and guarded-rollout qualification against representative existing worker databases.

## Live qualification

### Slice 1

A future separately approved production or appliance qualification demonstrates:

1. the complete configured database inventory and protected backups;
2. schema version 2 reported as `migratable` before migration;
3. guarded transactional migration to schema version 3;
4. both role tables, integrity, foreign keys, queue counts, ownership, modes, and hashes validated;
5. desired assignments reported as `configured_dormant`;
6. `Role routing: disabled` and unchanged effective legacy chains;
7. no duplicate revision for identical desired configuration;
8. no secret or raw content exposure;
9. service and queue/lease health after the separately approved restart;
10. protected rollback evidence.

Production qualification is observational and separately approved. It does not occur implicitly on merge.

### Later active role routing

Before broad rollout, use a disposable workspace to demonstrate:

1. one authenticated CLI with per-role model, prompt, and lifecycle-skill selection;
2. a feature request requiring one human clarification;
3. a detailed imported issue passing validation without unnecessary questions;
4. a multi-issue split blocked until bundle review is consistent;
5. a rejected defect or refactor candidate;
6. a Technical Lead plan with classified paths and product/architecture-grounded red tests;
7. rejection and focused repair of generic test wording or unclassified paths;
8. read-only scan followed by approved TDD implementation;
9. implementation and operations review before documentation;
10. same-head documentation-only mutation and validation;
11. stale required documentation blocking readiness until corrected;
12. restart between phases without duplicate calls or prompt/skill drift;
13. cancellation fencing late output;
14. accurate non-independent review reporting;
15. provider fallback preserving prompt and skill identities;
16. rollback to legacy routing without queue or state corruption.

Production qualification is observational and separately approved. It does not occur implicitly on merge.
