# Issue #159 Addendum — Prompt Separation and Advisor Red-Test Planning

## Status

Normative implementation-plan addendum. This document and `docs/implementation-plans/issue-159-role-based-orchestration.md` together form the approved coding-agent handoff.

## Decision

The Technical Lead owns test-strategy design during implementation planning. The Code Worker implements the approved red-test packet; it must not receive a vague instruction such as `write tests` and then infer product or architectural intent independently.

Technical Lead plans must specify red tests with the same discipline used in the Issue #159 epic plan:

- product behaviour being protected;
- architectural ownership or invariant being protected;
- the real production boundary and caller path;
- authoritative observable result;
- why the current implementation must fail;
- focused command and expected red assertion;
- sibling behaviour and compatibility that remain green;
- lifecycle, race, security, operations, migration, or rollback coverage triggered by risk.

Prompts remain separate by role, mode, and repair purpose as defined in `docs/architecture/agentic-prompt-contracts.md`.

## Minimal-change implementation

Extend the current prompt-template loader, `workerPrompts` ownership, existing database-backed named prompt overrides, `AdvisorService`, implementation-plan schema/quality validator, and PR #157 focused-repair pattern.

Do not introduce:

- a second prompt database or prompt service;
- prompt-owned tool or permission policy;
- one shared mega-prompt for all role modes;
- a new planning handler solely to hold prompt text;
- a second plan validator;
- provider-specific prompt schemas.

The effective prompt is resolved immediately before the existing role invocation and is bound to one role, mode, contract version, validator, tool grant, and permission profile.

## Planning output changes

Extend the canonical implementation-plan structured output with:

```ts
type ImplementationPlan = {
  // existing canonical plan fields
  red_tests: RedTestSpec[];
  acceptance_coverage: Array<{
    requirement_id: string;
    red_test_ids: string[];
    non_test_proof?: string;
  }>;
  architecture_coverage: Array<{
    boundary_or_invariant: string;
    red_test_ids: string[];
    characterization_test_ids?: string[];
  }>;
  triggered_risk_coverage: Array<{
    risk: string;
    required_test_classes: string[];
    red_test_ids: string[];
  }>;
};
```

`RedTestSpec` is defined canonically in `docs/architecture/agentic-prompt-contracts.md`.

The textual plan rendered for humans must include a **Red tests** section that is generated from the validated structured data. The rendered prose is not a separate source of truth.

## Planning validator changes

Extend the existing implementation-plan validator rather than creating another validator.

The validator must prove:

1. Every acceptance criterion has at least one mapped red test or a justified deterministic non-test proof.
2. Every affected architecture boundary or invariant has appropriate structural/integration coverage.
3. Tests identify the real caller boundary and authoritative observable result.
4. Tests state why current code fails and the expected red assertion.
5. Tests include a focused command and expected sibling-green behaviour.
6. Product, architecture, compatibility, lifecycle, security, and operations intent are covered where triggered.
7. Generic or placeholder test instructions are rejected.
8. Helper-only tests are rejected when production wiring is material.
9. Test oracles do not copy production ranking, parsing, transition, permission, or migration logic.
10. Refactors identify required characterization before behavioural red tests.
11. Existing tests cited as sufficient are identified by exact file/test and mapped to intent.
12. Test targets and commands are consistent with repository evidence and current ownership.

Validation errors are typed and section-specific so they can drive the focused red-test repair prompt without reopening the whole plan.

## Prompt registry implementation

Add a central registry describing every prompt contract. The registry owns metadata, not role authority.

Suggested shape:

```ts
type PromptContract = {
  key: PromptKey;
  version: number;
  role: AgentRole;
  mode: AgentMode;
  inputSchemaId: string;
  outputSchemaId: string;
  validatorId: string;
  repairKey?: PromptKey;
  required: boolean;
  compatibilityAliases: string[];
};
```

The loader returns:

```ts
type EffectivePrompt = {
  key: PromptKey;
  version: number;
  source: "builtin" | "database_override" | "compatibility_alias";
  content: string;
  contentHash: string;
};
```

Agent Bridge separately supplies tools, permissions, budgets, context, lifecycle owner, and validator. These are not fields controlled by prompt text or the override record.

## Database override compatibility

Preserve the current named-template capability, but make compatibility explicit.

Additive migration options must be reconciled with the current prompt table during Slice 0. The smallest acceptable implementation may retain the existing table and add version/metadata through a companion table or owning repository when changing the table would create unnecessary risk.

Required behaviour:

- exact registered keys only;
- contract-version compatibility check;
- required-placeholder/input check;
- built-in validator always applies;
- effective key/version/source/hash audited;
- raw prompt and supplied repository context remain outside metadata-only audit;
- invalid required override fails closed or uses the built-in prompt according to an explicit per-contract policy;
- no fallback to a sibling role/mode prompt;
- compatibility aliases remain visible and degraded until retired.

## Focused repair sequence

Use separate prompts:

1. `technical_lead:planning` creates the full plan once.
2. The existing validator checks all plan sections.
3. If only `red_tests` or its coverage matrices are invalid, call `technical_lead:planning_repair:red_tests` once.
4. The repair input contains the immutable canonical issue, original plan, repository evidence references, and typed red-test validation failures.
5. The repair output contains only replacement red-test and coverage sections.
6. Agent Bridge merges those sections and revalidates the complete plan.
7. If the execution contract alone is invalid, use the separate PR #157-style execution-contract repair.
8. If multiple substantive sections are invalid, fail the full plan rather than chaining several autonomous repairs.

The red-test repair prompt cannot alter requirements, scope, non-goals, architecture, implementation packets, permissions, operations policy, or human gates.

## Red tests for this implementation slice

Each child issue implementing prompt and plan changes must refine exact file names after current-state reconciliation, but it must begin with these production-boundary red tests.

### 1. Planning rejects generic test wording

- **Boundary:** existing implementation-plan parser/quality validator through the real planning handler.
- **Fixture:** valid canonical feature issue and otherwise valid plan containing `write unit tests` with no red-test specification.
- **Action:** process the model response through the production plan validation path.
- **Expected:** fail closed with typed missing red-test boundary/intent/coverage errors; nothing canonical is persisted.
- **Why red now:** current plan validation does not require the comprehensive `RedTestSpec` contract.
- **Sibling green:** existing missing-execution-contract repair remains unchanged.

### 2. Product and architecture intent must both be mapped

- **Boundary:** production planning validator.
- **Fixture:** architecture-affecting refactor with behavioural acceptance criteria, public compatibility invariant, and ownership boundary.
- **Action:** validate a plan containing only a narrow helper unit test.
- **Expected:** rejection for missing architecture/compatibility coverage and real caller boundary.
- **Why red now:** current path can accept test prose without intent coverage matrices.
- **Sibling green:** a low-risk local behaviour change is not forced to invent irrelevant architecture tests.

### 3. Lifecycle risks trigger lifecycle red tests

- **Boundary:** planning validator with canonical issue risk metadata.
- **Fixture:** change affecting cancellation, retry, lease ownership, and restart.
- **Action:** validate a plan containing only happy-path behaviour tests.
- **Expected:** rejection naming missing cancellation/restart/lease/terminal-state test classes.
- **Why red now:** risk-trigger-to-test-class validation does not exist.
- **Sibling green:** non-lifecycle work has no artificial lifecycle-test requirement.

### 4. Exact red-test contract persists and renders

- **Boundary:** planning handler, durable phase state, and human plan renderer.
- **Fixture:** valid plan containing multiple `RedTestSpec` records and coverage matrices.
- **Action:** validate and persist through the real handler, then reload/render after simulated restart.
- **Expected:** structured records survive byte/semantic equivalence; human Red tests section derives from them; prompt key/version/source/hash are recorded.
- **Why red now:** fields and durable wiring do not exist.
- **Sibling green:** existing execution contract and plan fields remain compatible.

### 5. Focused red-test repair is section-only

- **Boundary:** production planning/repair flow.
- **Fixture:** otherwise valid plan with inadequate red tests.
- **Action:** run one targeted repair response that also attempts to change scope and packets.
- **Expected:** only valid red-test/coverage fields are eligible; scope changes are rejected; full plan revalidation is required.
- **Why red now:** dedicated red-test repair prompt and merge guard do not exist.
- **Sibling green:** execution-contract-only repair still uses its separate key and behaviour.

### 6. Prompt contracts are mode-separated

- **Boundary:** production prompt registry/loader invoked by role dispatch.
- **Fixture:** all registered Technical Lead, Code Worker, and Documentation Steward modes.
- **Action:** resolve each effective prompt.
- **Expected:** exact distinct key and compatible contract version for each mode; no planning prompt used for review, operations, code, or documentation.
- **Why red now:** target role/mode registry does not yet exist.
- **Sibling green:** legacy named prompts resolve unchanged while role routing is disabled.

### 7. Override cannot weaken authority

- **Boundary:** DB prompt override loader plus role dispatch.
- **Fixture:** override text asking for shell, writes, GitHub mutation, relaxed schema, or additional calls.
- **Action:** invoke Technical Lead planning.
- **Expected:** original read-only tools, permission profile, call budget, schema, and validator remain effective; prohibited action is unreachable.
- **Why red now:** role-aware override compatibility is not yet enforced.
- **Sibling green:** valid text-only overrides continue to work.

### 8. Version and placeholder mismatch fail safely

- **Boundary:** prompt repository/loader.
- **Fixture:** unknown key, incompatible version, and missing required input placeholder.
- **Action:** resolve a required Technical Lead planning prompt.
- **Expected:** explicit validation failure or contract-configured built-in fallback; never a sibling prompt or silent legacy path.
- **Why red now:** versioned role prompt contracts do not exist.
- **Sibling green:** compatible existing overrides remain available.

### 9. Fallback models share one contract

- **Boundary:** AdvisorService fallback through role prompt resolution.
- **Fixture:** primary capacity failure followed by secondary target.
- **Action:** execute planning fallback.
- **Expected:** both attempts use the same prompt key/version, input contract, output schema, validator, and red-test requirements; only target/model differs.
- **Why red now:** current provider fallback is not tested against role prompt identity.
- **Sibling green:** physical attempts still consume one logical-call budget according to current advisor policy.

### 10. Prompt changes remain isolated

- **Boundary:** registry and dynamic override integration.
- **Fixture:** update only `technical_lead:planning` text.
- **Action:** resolve and snapshot every registered prompt contract.
- **Expected:** only planning content hash changes; keys, schemas, validators, permissions, and sibling prompt hashes remain unchanged.
- **Why red now:** no registry-level isolation contract exists.
- **Sibling green:** existing prompt customisation remains scoped by name.

## Architecture Lint and structural guards

Add structural checks proving:

- one central prompt-contract registry;
- prompt text does not define permission/tool/budget policy;
- role handlers resolve registered prompts rather than embedding large independent prompt copies;
- planning and focused repairs use different keys;
- Technical Lead prompts route through `AdvisorService`;
- Code Worker and Documentation Steward prompts cannot be selected for Technical Lead modes;
- compatibility aliases are explicit and cannot silently become canonical.

Avoid brittle exact-prompt-text snapshots as the primary oracle. Test keys, contract metadata, required semantic instructions, structured schemas, validators, and effective isolation. Prompt-copy changes may use focused golden fixtures where wording itself is the contract.

## Documentation updates required with implementation

Update:

- `docs/WORKER-GUIDE.md` with the effective prompt registry and override rules;
- `docs/testing/agentic-worker-verification.md` with plan red-test and prompt-isolation suites;
- `docs/architecture/agentic-prompt-contracts.md` when the delivered registry differs from planned names;
- `agentic-maintenance.yaml` when prompt changes trigger canonical documentation;
- configuration/status documentation for prompt version/source/hash visibility;
- `AGENTS.md` signposting if the coding-agent workflow should require reading the advisor-authored red-test contract.

## Completion criteria

This addendum is complete only when:

- Technical Lead plans cannot pass with generic test instructions;
- comprehensive red-test specifications protect product and architectural intent;
- acceptance, architecture, and risk coverage matrices are validated and durable;
- red-test repair and execution-contract repair remain separate and bounded;
- every role/mode has a distinct registered prompt contract;
- DB overrides are compatible, versioned, isolated, and incapable of changing authority;
- legacy prompt paths remain compatible while disabled role phases are not migrated;
- exact-head focused/full tests, typecheck, Architecture Lint, cleanup accounting, and CI pass;
- independent review confirms no prompt path can bypass the role, permission, validator, or lifecycle boundaries.
