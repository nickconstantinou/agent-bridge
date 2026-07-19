# Agentic Worker Verification Contract

## Status

Canonical verification requirements for role-based Engineering Worker orchestration.

## Test principles

- Write boundary-level acceptance tests before implementation.
- Preserve red-green-refactor with separate red and green commits for behaviour changes.
- Test authoritative state and externally observable effects rather than model wording.
- Treat permission, lifecycle, persistence, role resolution, structured output, and documentation triggers as risk boundaries.
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
- one model can serve every role with separate sessions and permission profiles;
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

### Planning

Cover:

- planning requires `requirements_ready`;
- plans trace every acceptance criterion;
- execution contracts include bounded work packets, red/green phases, verification, documentation, and operations obligations;
- plan target paths are repository-relative and policy-valid;
- legacy scribe output cannot silently become the canonical plan when role routing is authoritative;
- current PR #157 contract-repair behaviour remains valid as transitional hardening until replacement is complete.

### Code Worker permission modes

Cover:

- scan/investigate cannot mutate files or Git;
- red can commit test files only and must demonstrate expected failure;
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
- rollback to legacy routing preserves new records without interpreting incompatible jobs unsafely.

### Review and operations

Cover:

- different-target preference order;
- fresh isolated session when target is reused;
- accurate independent/non-independent status;
- implementation review occurs only after deterministic verification;
- operations review activates on configuration, credentials, schema, migration, queue, service, deployment, or rollback changes;
- model verdict cannot mark failed deterministic evidence ready.

## Structural checks

Architecture Lint should enforce:

- role IDs and permission profiles are centrally owned;
- worker handlers do not invoke provider CLIs directly for role work;
- Technical Lead calls route through the advisor boundary;
- documentation-only handlers cannot import production mutation helpers;
- role audit SQL remains in its owning repository;
- no legacy scribe call is used as canonical planning without an explicit compatibility marker;
- role status handlers remain read-only.

## Required commands

The implementation plan must resolve exact repository commands. At minimum, final evidence includes:

```text
focused role and workflow tests
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

1. one authenticated CLI with per-role model selection;
2. a feature request requiring one human clarification;
3. a detailed imported issue passing validation without unnecessary questions;
4. a rejected defect or refactor candidate;
5. a read-only scan followed by approved TDD implementation;
6. documentation-only mutation enforced;
7. restart between workflow phases without duplicate calls;
8. cancellation fencing late output;
9. accurate non-independent review reporting when only one model exists;
10. rollback to legacy routing without queue or state corruption.

Production qualification is observational and separately approved. It does not occur as an implicit consequence of merging implementation code.