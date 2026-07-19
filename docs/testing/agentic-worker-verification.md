# Agentic Worker Verification Contract

## Status

Canonical verification requirements for role-based Engineering Worker orchestration.

## Test principles

- Write boundary-level acceptance tests before implementation.
- Preserve red-green-refactor with separate red and green commits for behaviour changes.
- Test authoritative state and externally observable effects rather than model wording.
- Treat permission, lifecycle, persistence, role resolution, prompts, structured output, and documentation triggers as risk boundaries.
- Require Technical Lead plans to define comprehensive red tests protecting product and architectural intent.
- Deterministic evidence overrides model claims.

## Acceptance suites

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
- no false claim of independent review.

### Requirements intake

For feature, defect, and refactor paths, cover:

- incomplete input cannot reach planning;
- apparently complete GitHub and local issues still receive validation;
- repository facts are gathered without asking the user unnecessarily;
- unresolved product decisions pause for human input;
- issue validation verdict schemas reject malformed output;
- canonical issue versions and `requirements_ready` transitions are durable;
- restart and retry do not duplicate validation calls.

### Scan candidate handling

Cover:

- Code Worker scans run read-only;
- defect and refactor findings remain candidates;
- every supported Technical Lead disposition;
- duplicate, rejected, and split findings do not accidentally queue implementation;
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

### Prompt registry and override isolation

Cover:

- every role/mode resolves exactly one registered prompt key and contract version;
- planning, red-test repair, execution-contract repair, review, operations, guidance, Code Worker, and Documentation Steward prompts remain separate;
- fallback targets use the same prompt key/version, input/output schemas, validator, and stable source-template hash;
- changing one prompt does not change sibling prompt template hashes or contracts;
- every canonical prompt declares its required render variables and missing inputs fail closed;
- supplied context is bounded before rendering;
- canonical role prompts ignore database prompt rows and always resolve `source: builtin`;
- legacy database overrides remain available only to explicitly unmigrated compatibility handlers;
- legacy override text cannot change role, mode, tools, permissions, budget, validator, repair count, or lifecycle authority;
- unknown keys and incompatible legacy override inputs fail safely;
- compatibility aliases remain explicit and degraded;
- stable source-template hash and invocation-specific rendered-content hash are distinguished and audit-safe;
- raw repository context and sensitive prompt inputs are not stored in metadata-only audit.

Canonical contract: `docs/architecture/agentic-prompt-contracts.md`.

### Planning

Cover:

- planning requires `requirements_ready`;
- plans trace every acceptance criterion;
- execution contracts include bounded work packets, red/green phases, verification, documentation, and operations obligations;
- plan target paths are repository-relative and policy-valid;
- legacy scribe output cannot silently become the canonical plan when role routing is authoritative;
- current PR #157 execution-contract repair remains separate transitional hardening until replacement is complete.

Every valid Technical Lead plan must also contain structured comprehensive red-test specifications. Cover:

- every acceptance criterion maps to one or more red tests or a justified deterministic non-test proof;
- affected product behaviour and architectural boundaries/invariants are named explicitly;
- each red test identifies file/name, real production boundary, fixture/state, real caller action, observable result, why current code fails, expected red assertion, focused command, authoritative oracle, false-positive controls, and sibling behaviour remaining green;
- architecture/refactor work includes characterization and structural/Architecture Lint coverage where applicable;
- lifecycle work triggers cancellation, retry, restart, lease, stale-owner, race, and terminal-state coverage as applicable;
- permission/security work triggers deny-path and credential-isolation coverage;
- operational work triggers abort, rollback, and authoritative postcondition coverage;
- generic instructions such as `write tests`, `add unit tests`, or `increase coverage` fail validation;
- helper-only tests fail validation when correctness depends on handler wiring, repositories, permissions, child processes, Git/GitHub, platform status, or operations;
- cited existing tests identify exact file/test and prove why they cover the required intent;
- rendered human plan red-test prose is derived from the validated structured contract;
- red-test specifications survive restart without semantic drift.

### Focused plan repair

Cover:

- inadequate red-test sections use only `technical_lead:planning_repair:red_tests`;
- missing execution contracts use only the separate execution-contract repair key;
- red-test repair can replace only red-test and coverage fields;
- attempted scope, non-goal, packet, architecture, permission, operation, or human-gate changes are rejected;
- one repair is allowed and the full plan is revalidated;
- multiple substantive invalid sections fail the plan rather than chaining autonomous repairs;
- failure after bounded repair is fail-closed.

### Code Worker permission modes

Cover:

- scan/investigate cannot mutate files or Git;
- red can commit test files only and must demonstrate the exact planned expected failure;
- Code Worker red receives the validated `RedTestSpec`, not free-form test-strategy ownership;
- green cannot alter committed red tests;
- repair cannot escape the approved packet;
- verify cannot introduce new source changes;
- permission tokens are invocation-scoped and revoked on completion, cancellation, timeout, or lease loss.

### Documentation Steward

Cover:

- impact and validation are read-only;
- author mode can change only manifest-approved documentation paths;
- production-code and test-code mutations are rejected;
- manifest triggers resolve required documents deterministically;
- a `no_documentation_change` result requires rationale and validation;
- PR readiness remains blocked while required documents are missing or stale.

### Lifecycle and persistence

Cover:

- cancellation prevents new role calls and fences late output;
- terminal states cannot be overwritten;
- restart resumes from authoritative phase state;
- lease loss prevents duplicate calls and persistence;
- logical-call budget is preserved across retries and restart;
- completed phases are not rerun;
- stale model probes are revalidated before new calls;
- prompt contract, version, source-template hash, and rendered invocation hash remain bound to each durable logical call;
- rollback to legacy routing preserves new records without interpreting incompatible jobs unsafely.

### Review and operations

Cover:

- different-target preference order;
- fresh isolated session when target is reused;
- accurate independent/non-independent status;
- implementation review occurs only after deterministic verification;
- review checks delivered tests against the approved red-test contract and flags omitted product/architectural intent;
- operations review activates on configuration, credentials, schema, migration, queue, service, deployment, or rollback changes;
- model verdict cannot mark failed deterministic evidence ready.

## Structural checks

Architecture Lint should enforce:

- role IDs and permission profiles are centrally owned;
- one central prompt-contract registry owns role/mode prompt metadata;
- worker handlers do not invoke provider CLIs directly for role work;
- Technical Lead calls route through the advisor boundary;
- full planning and focused repair use different registered prompt keys;
- prompt text cannot own or import tool, permission, budget, or lifecycle policy;
- Code Worker and Documentation Steward prompts cannot be selected for Technical Lead modes;
- canonical prompt loading cannot depend on the database prompt repository;
- documentation-only handlers cannot import production mutation helpers;
- role audit SQL remains in its owning repository;
- no legacy scribe call is used as canonical planning without an explicit compatibility marker;
- role status handlers remain read-only.

## Required commands

The implementation plan must resolve exact repository commands. At minimum, final evidence includes:

```text
focused role, prompt, plan-validation, and workflow tests
full test suite
npm run typecheck
bash scripts/arch-lint.sh src
npm run cleanup:check or documented pre-existing findings
git diff --check
exact-head GitHub Actions checks
```

Migration work additionally runs upgrade and rollback tests against representative existing worker databases.

## Live qualification

Before broad rollout, use a disposable workspace to demonstrate:

1. one authenticated CLI with per-role model and prompt selection;
2. a feature request requiring one human clarification;
3. a detailed imported issue passing validation without unnecessary questions;
4. a rejected defect or refactor candidate;
5. a Technical Lead plan containing product- and architecture-grounded red-test specifications;
6. rejection and focused repair of a plan containing only generic test wording;
7. a read-only scan followed by approved TDD implementation of the exact planned red tests;
8. documentation-only mutation enforced;
9. restart between workflow phases without duplicate calls or prompt-contract drift;
10. cancellation fencing late output;
11. accurate non-independent review reporting when only one model exists;
12. canonical prompt loading remains source-controlled even when a conflicting legacy database row exists;
13. rollback to legacy routing without queue or state corruption.

Production qualification is observational and separately approved. It does not occur as an implicit consequence of merging implementation code.
