# Agent Role Assignment Configuration

## Status

Slice 1 of Issue #159 is implemented by Issue #161. Agent Bridge can now validate, persist, version, and report explicit desired role assignments, but the feature is deliberately dormant:

- desired assignments are reported as `configured_dormant`;
- role routing is disabled;
- existing `WORKER_CLI_CHAIN`, `WORKER_CODE_CLI_CHAIN`, and `WORKER_SCRIBE_CLI_CHAIN` values remain the effective execution policy;
- capability resolution, permission profiles, automatic selection, recommended selection, review-target selection, and later-slice lifecycle behaviour are not active.

The remainder of this document distinguishes the current Slice 1 contract from the later target state defined by PR #160 and ADR-005.

## Current Slice 1 configuration

The worker accepts one optional JSON environment variable and one optional scope variable:

- `WORKER_ROLE_ASSIGNMENTS_JSON` — an array containing exactly one assignment for each public role;
- `WORKER_ROLE_ASSIGNMENT_SCOPE` — a bounded workspace/scope identifier; defaults to `worker:default`.

Example:

```json
[
  {
    "role": "technical_lead",
    "selection": "manual",
    "primary": { "cli": "claude", "model": "claude-fable-5" },
    "fallbacks": [{ "cli": "codex", "model": "gpt-5.6-sol" }]
  },
  {
    "role": "code_worker",
    "selection": "manual",
    "primary": { "cli": "codex", "model": "gpt-5.6-sol" },
    "fallbacks": [{ "cli": "claude", "model": "claude-sonnet-5" }]
  },
  {
    "role": "documentation_steward",
    "selection": "manual",
    "primary": { "cli": "antigravity", "model": "gemini-3.1-pro" },
    "fallbacks": []
  }
]
```

The parser is fail-closed. It rejects:

- missing, duplicate, or unknown roles;
- a mode name presented as a role;
- unknown fields;
- credential-, prompt-, or repository-content-shaped fields;
- credential-shaped values;
- unbounded or malformed scope, CLI, or model identifiers;
- duplicate primary/fallback targets;
- more than four fallbacks for one role.

The persisted record contains only scope, revision, source, dormant status, deterministic idempotency identity, bounded CLI/model identifiers, selection labels, fallbacks, and timestamps. It does not store tokens, API keys, credentials, prompts, repository content, capability results, or permission profiles.

### Startup and persistence

Role configuration is parsed before the worker opens its production database. Invalid configuration therefore fails before role persistence.

A valid explicit configuration is persisted through the existing `BridgeDb` compatibility façade and the sole role-assignment repository. Repeating the identical configuration returns the same revision. A changed valid configuration creates the next revision for the same scope.

Production startup remains strict: ordinary services accept only the current schema version. Schema version 2 databases must be upgraded to schema version 3 through the guarded rollout helper before a schema-3 worker is started.

### Current status surface

`/chain` preserves its legacy output when no role assignment revision exists. When a revision exists it additionally reports:

- `Role assignments: configured_dormant`;
- desired revision and configuration source;
- desired primary and fallback targets for each role;
- `Role routing: disabled`;
- the effective legacy interactive, code, and scribe chains.

Desired configuration is never labelled effective. No assignment value is consulted by an existing job handler or interactive dispatch path.

## Roles and modes

Agent Bridge exposes exactly three configurable workspace roles:

- `technical_lead`;
- `code_worker`;
- `documentation_steward`.

Modes are not separately configurable roles.

Technical Lead modes:

- `requirements`;
- `issue_validation`;
- `issue_authoring`;
- `decomposition_review`;
- `planning`;
- `planning_repair`;
- `executor_guidance`;
- `implementation_review`;
- `operations_review`;
- `pr_readiness`.

Code Worker modes:

- `scan`;
- `investigate`;
- `red`;
- `green`;
- `repair`;
- `verify`.

Documentation Steward modes:

- `impact`;
- `author`;
- `validate`;
- `maintenance`.

Scanner is a Code Worker mode. Reviewer, operations, planning, decomposition review, and readiness are Technical Lead modes.

## Target-state assignment model — later slices

The following richer model is the canonical target state, not the current Slice 1 persisted schema:

```yaml
roles:
  technical_lead:
    selection: automatic | recommended | manual
    primary:
      cli: claude
      model: claude-fable-5
    fallbacks:
      - cli: codex
        model: gpt-5.6-sol
    permission_profile: advisor_read_only
    review_preference: different_from_executor
    max_logical_calls: 4
    timeout_ms: 120000

  code_worker:
    selection: automatic | recommended | manual
    primary:
      cli: codex
      model: <coding-model>
    fallbacks:
      - cli: claude
        model: <coding-model>
    permission_profiles:
      scan: repository_read_only
      investigate: repository_read_only
      red: test_only_mutation
      green: worktree_mutation
      repair: bounded_worktree_mutation
      verify: verification_only

  documentation_steward:
    selection: automatic | recommended | manual
    primary:
      cli: agy
      model: <documentation-model>
    fallbacks:
      - cli: claude
        model: <writing-model>
    permission_profiles:
      impact: repository_read_only
      author: documentation_only
      validate: repository_read_only
      maintenance: documentation_only
```

A CLI name without a model is not a complete explicit assignment.

## Target-state assignment modes — later slices

Slice 1 persists the `automatic`, `recommended`, and `manual` labels but does not execute their resolution behaviour.

### Automatic

Later slices rank authenticated targets using verified capability metadata and workspace policy.

### Recommended

Later slices propose assignments and expose reasoning tier, coding/documentation suitability, structured-output support, permission compatibility, cost tier, fallback coverage, and review independence before acceptance.

### Manual

Later slices validate selected primary and fallback CLI/model targets against role capability and permission contracts before activation.

## Target-state capability metadata — later slices

Each discovered target will record:

```yaml
cli: codex
model: <model-id>
authenticated: true
capabilities:
  reasoning_tier: frontier | strong | standard
  coding_tier: strong | standard | unsuitable
  documentation_tier: strong | standard | unsuitable
  structured_output: verified | unverified | failed
  read_only_mode: enforced | bridge_wrapped | unavailable
  context_tier: large | medium | small
  cost_tier: high | medium | low
  latency_tier: high | medium | low
last_probe:
  status: passed | failed | stale
  checked_at: <timestamp>
```

CLI-supported discovery is preferred. Static provider metadata and manually entered model IDs are supported where discovery is unavailable, but a bounded validation probe is required before later activation.

## Target-state automatic ranking — later slices

- **Technical Lead:** reasoning quality, reliable structured output, read-only evidence compatibility, then cost and latency.
- **Code Worker:** coding success and repository-tool compatibility, then cost and latency.
- **Documentation Steward:** document quality, context capacity, structured output, then cost.

Fallback preserves required capability before optimising cost.

## Single-CLI and single-model target state — later slices

When only one CLI is authenticated, later resolution chooses a model separately for each role. When only one model is available, it may serve every role, but actual review independence remains `non_independent` and policy may hold the workflow for human decision.

A fresh session does not make same-model review independent. Every review records required and actual independence.

## Phase and exact-head stability

A later active logical call snapshots its role, mode, assignment revision, target, permission profile, prompt/skill identity, and subject revision where applicable.

Verification, implementation review, operations review, documentation, and readiness bind to one exact `subject_head_sha`. A code-changing repair invalidates later evidence for the old head; target reassignment or fallback does not permit reuse of stale evidence.

## Compatibility

Legacy `WORKER_CLI_CHAIN`, `WORKER_CODE_CLI_CHAIN`, and `WORKER_SCRIBE_CLI_CHAIN` remain authoritative in Slice 1. Explicit role configuration is desired state only and cannot override or participate in dispatch.

A later activation slice may make role configuration authoritative only after its own human gate, routing tests, capability-resolution implementation, and operational qualification.

## Platform requirements — later slices

The hosted platform target state provides authenticated CLI and model inventory, assignment controls, primary/fallback selection, budgets, review-independence policy, desired/applied revision status, non-mutating tests, and secret-safe audit history. Slice 1 does not add Platform transport or mutate Platform state.
