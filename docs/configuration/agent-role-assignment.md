# Agent Role Assignment Configuration

## Status

Canonical target-state configuration reference for Engineering Worker role allocation. PR #160 defines the contracts; later Issue #159 slices implement persistence, resolution, and activation.

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

## Assignment model

Each role resolves to a primary target and zero or more fallbacks:

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

The persisted schema stores explicit model IDs. A CLI name without a model is not a complete manual assignment.

## Assignment modes

### Automatic

Agent Bridge ranks authenticated targets using verified capability metadata and workspace policy.

### Recommended

Agent Bridge proposes assignments. The platform displays reasoning tier, coding/documentation suitability, structured-output support, permission compatibility, cost tier, fallback coverage, and review independence before the user accepts them.

### Manual

The user selects primary and fallback CLI/model targets. Agent Bridge still rejects targets that cannot satisfy the role's permission or structured-output contract.

## Capability metadata

Each discovered target records:

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

CLI-supported discovery is preferred. Static provider metadata and manually entered model IDs are supported where discovery is unavailable, but a bounded validation probe is required before selection.

## Automatic ranking

- **Technical Lead:** reasoning quality, reliable structured output, read-only evidence compatibility, then cost and latency.
- **Code Worker:** coding success and repository-tool compatibility, then cost and latency.
- **Documentation Steward:** document quality, context capacity, structured output, then cost.

Fallback preserves required capability before optimising cost.

## Single-CLI operation

When only one CLI is authenticated, Agent Bridge resolves a model separately for each role:

- Technical Lead: strongest suitable reasoning model;
- Code Worker: strongest cost-effective coding model;
- Documentation Steward: strongest writing or long-context model.

Every role uses a separate session, role prompt, permission profile, call budget, and audit record.

## Single-model operation

When only one model is available, it may serve every role. The status surface reports:

```text
Role separation: preserved
Model diversity: unavailable
Actual review independence: non_independent
Single-provider dependency: active
```

Work proceeds only when repository policy permits the actual independence level for the detected risk.

## Review target resolution

Technical Lead review preference is:

1. different CLI and model from the implementing Code Worker;
2. different model on the same CLI;
3. configured Technical Lead target in a fresh isolated session;
4. same target, marked `non_independent`.

A fresh session does not make same-model review independent. Every review records:

- `required_independence`;
- `actual_independence`;
- whether the independence gate is satisfied.

The workflow holds for human decision when policy requires a stronger level than is available. The platform does not expose a fourth Reviewer role.

## Phase and exact-head stability

An active logical call snapshots its role, mode, assignment revision, target, permission profile, prompt/skill identity, and subject revision where applicable.

Verification, implementation review, operations review, documentation, and readiness bind to one exact `subject_head_sha`. A code-changing repair invalidates later evidence for the old head; target reassignment or fallback does not permit reuse of stale evidence.

## Degraded states

Role status includes:

- requested assignment;
- effective primary and fallback;
- configuration source;
- authentication state;
- model-probe freshness;
- missing capabilities;
- model-diversity state;
- required and actual review-independence state;
- whether workspace policy permits execution.

No fallback or degraded state is silent.

## Compatibility

Legacy `WORKER_CODE_CLI_CHAIN` and `WORKER_SCRIBE_CLI_CHAIN` may be read during migration. Once role assignments are persisted and routing is explicitly activated, role configuration is authoritative. Legacy values remain visible compatibility inputs and do not silently override explicit role assignments.

PR #160 itself does not activate role routing. Until the relevant slices are implemented, current legacy worker CLI policy remains effective.

## Platform requirements

The hosted platform provides:

- authenticated CLI inventory;
- available-model inventory and probe status;
- automatic, recommended, and manual assignment controls;
- primary and fallback selection;
- per-role budget and timeout controls;
- review-independence policy;
- desired and exact applied revision status;
- effective/degraded/rejected/pending role status;
- a non-mutating role test action;
- audit history without secrets or raw unrestricted prompts.

Desired configuration is not represented as effective until the appliance reports the matching applied revision.
