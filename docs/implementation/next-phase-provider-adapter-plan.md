# Next Phase Implementation Plan: Provider Adapter Boundary

## Status

This plan follows the OSS v1.0 architecture roadmap and the Phase 0 hardening work.

Phase 0 must be treated as complete only when:

- capacity-exhaustion detection remains narrowly scoped and covered by regression tests;
- duplicate Telegram token validation is shared through the config boundary and covered by tests;
- architecture lint is either green or intentionally removed from required checks until it is baseline-safe.

Do not start broad workflow-engine or event-sourcing work before the provider boundary is stable.

## Objective

Introduce a small, testable provider-adapter boundary for CLI providers so Agent Bridge can route Codex, Claude, Agy/Antigravity, and future CLIs without scattering provider-specific branching through bot entrypoints, worker handlers, or session orchestration.

The goal is not to build a generic agent framework yet. The goal is to isolate provider-specific process spawning, prompt wrapping, capability metadata, capacity detection, and session behaviour behind a narrow contract.

## Non-goals

- No rewrite of the worker bot.
- No new workflow engine.
- No event-sourced migration.
- No platform billing/auth/provisioning changes.
- No change to Telegram/Discord user-facing behaviour unless required to preserve compatibility.
- No provider marketplace or plugin loader.

## Design principles

1. Keep runtime behaviour stable while moving provider-specific logic behind interfaces.
2. Prefer additive extraction over large rewrites.
3. Preserve SQLite state compatibility.
4. Keep OSS responsible for CLI routing and worker execution.
5. Keep the private platform responsible only for workspace provisioning and configuration.
6. Every extraction step must land with regression tests before production code moves further.

## Proposed target structure

```text
src/providers/
  types.ts
  registry.ts
  codex.ts
  claude.ts
  agy.ts
  capacity.ts

src/runtime/
  cliSession.ts
  providerRouter.ts

src/config.ts
```

This structure is intentionally modest. Do not introduce `roles/`, `playbooks/`, or `workflows/` until this boundary proves stable.

## ProviderAdapter contract

Create a narrow interface first, then migrate providers one at a time.

```ts
export type ProviderId = 'codex' | 'claude' | 'agy';

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  executable: string;
  defaultArgs: readonly string[];
  supportsInteractiveSession: boolean;
  supportsWorkerAutomation: boolean;
  classifyError(output: string, exitCode?: number): ProviderErrorClassification;
  buildInvocation(input: ProviderInvocationInput): ProviderInvocation;
}

export interface ProviderInvocationInput {
  prompt: string;
  workingDirectory?: string;
  sessionId?: string;
  environment?: Record<string, string>;
}

export interface ProviderInvocation {
  command: string;
  args: readonly string[];
  env?: Record<string, string>;
  stdin?: string;
}

export type ProviderErrorClassification =
  | { kind: 'capacity_exhausted'; reason: string }
  | { kind: 'auth_required'; reason: string }
  | { kind: 'model_unavailable'; reason: string }
  | { kind: 'transient'; reason: string }
  | { kind: 'fatal'; reason: string }
  | { kind: 'unknown'; reason: string };
```

Keep this contract boring. Avoid provider-specific methods until a second provider proves the need.

## Implementation sequence

### Step 1: Add provider types and registry tests

Create `src/providers/types.ts` and `src/providers/registry.ts`.

Acceptance criteria:

- registry resolves all configured provider ids;
- unknown provider ids fail with a clear error;
- provider ids are typed, not raw strings throughout new code;
- no bot or worker behaviour changes.

Test-first tasks:

- add unit tests for successful provider lookup;
- add unit tests for unknown provider lookup;
- add type-level or runtime validation for supported provider ids.

### Step 2: Extract capacity/error classification

Move provider-specific capacity detection into `src/providers/capacity.ts` or adapter-local classifiers.

Acceptance criteria:

- existing `isCapacityExhaustedError` behaviour is preserved;
- model-not-found remains classified only when the existing narrow conditions are met;
- generic missing-model text must not be treated as capacity exhaustion;
- tests document all known provider output patterns.

Test-first tasks:

- add regression tests for Codex capacity text;
- add regression tests for Agy/Antigravity usage exhaustion text;
- add regression tests for Claude auth/capacity text if current behaviour exists;
- add negative tests for ordinary model/tool errors.

### Step 3: Add the first adapter without switching callers

Implement one adapter, preferably Codex, behind the new interface. Keep existing code paths active until tests prove parity.

Acceptance criteria:

- Codex adapter builds the same command, args, env, and stdin shape as existing runtime;
- no bot command output changes;
- no worker execution change yet;
- adapter has unit coverage independent of Telegram/Discord.

Test-first tasks:

- snapshot or explicit assertion tests for Codex invocation;
- error-classification tests;
- config default tests.

### Step 4: Route interactive CLI execution through registry

Switch the interactive/companion bot path to resolve providers through the registry.

Acceptance criteria:

- Telegram companion bot still routes to the selected CLI;
- Discord path still routes to the selected CLI if supported today;
- fallback behaviour is unchanged;
- session persistence remains compatible with existing SQLite rows.

Test-first tasks:

- add routing tests for selected provider;
- add fallback tests when selected provider is exhausted;
- add session continuity tests across provider switch if supported today.

### Step 5: Add Claude and Agy adapters

Migrate remaining providers after Codex parity is established.

Acceptance criteria:

- all supported providers resolve through the same registry;
- provider-specific command details live in adapter files;
- no provider-specific command construction remains in bot entrypoints.

Test-first tasks:

- adapter invocation tests for each provider;
- provider-specific error classifier tests;
- compatibility tests for configured environment variables.

### Step 6: Route worker CLI execution through registry

Only after companion routing is stable, move worker provider selection to the same registry.

Acceptance criteria:

- worker handlers no longer construct provider command lines directly;
- worker retry/fallback behaviour is preserved;
- merge gates, SHA checks, and destructive-operation approval rules are unchanged;
- work job state remains backward compatible.

Test-first tasks:

- worker job execution test using a fake adapter;
- capacity-exhaustion fallback test;
- failing provider does not mutate repository state unexpectedly;
- PR merge-gate tests still pass.

## Migration guardrails

- One provider migration per PR after the initial type/registry PR.
- Do not change DB schema in the provider-adapter PR unless unavoidable.
- Do not mix provider extraction with worker lifecycle/event changes.
- Do not introduce a role/playbook layer in this phase.
- Do not change public bot commands without a README/docs update.

## Suggested PR breakdown

### PR 1: Provider types and registry

Files likely touched:

- `src/providers/types.ts`
- `src/providers/registry.ts`
- provider registry tests

Outcome: no runtime behaviour change.

### PR 2: Provider error classification extraction

Files likely touched:

- `src/providers/capacity.ts`
- existing CLI/capacity tests
- minimal caller update if necessary

Outcome: capacity/error detection becomes provider-owned.

### PR 3: Codex adapter parity

Files likely touched:

- `src/providers/codex.ts`
- adapter tests
- possibly config tests

Outcome: adapter exists but callers may still use old path.

### PR 4: Companion bot provider routing

Files likely touched:

- interactive/companion CLI routing code
- provider router tests

Outcome: companion bot uses provider registry.

### PR 5: Claude and Agy adapters

Files likely touched:

- `src/providers/claude.ts`
- `src/providers/agy.ts`
- adapter tests

Outcome: all companion providers use the same adapter contract.

### PR 6: Worker provider routing

Files likely touched:

- worker orchestration/provider selection code
- worker tests with fake adapter

Outcome: worker uses provider registry without changing workflow semantics.

## Architecture lint after this phase

Only after PR 6 is green should architecture lint grow beyond test-import checks.

Candidate future rules:

- provider command construction must live under `src/providers/`;
- bot entrypoints must not branch directly on provider-specific executable names;
- raw SQLite access should move toward `src/db.ts` and repository modules only, but only after the repository layer baseline is real.

## Risks

### Risk 1: adapter abstraction becomes too large

Mitigation: keep the first contract limited to invocation and classification. Add methods only after two providers need the same extension.

### Risk 2: worker migration breaks merge safety

Mitigation: worker routing is last. PR merge gates, SHA checks, branch isolation, and approval callbacks must be protected by regression tests before worker adapter migration.

### Risk 3: fallback semantics change accidentally

Mitigation: write fallback tests before switching callers to the registry.

### Risk 4: config compatibility breaks existing installs

Mitigation: keep existing env vars working. Add new config keys only as aliases first, then document deprecation later.

## Definition of done for the phase

- all provider command construction is behind adapters;
- all capacity/auth/model classification is provider-owned;
- companion bot routing uses the provider registry;
- worker routing uses the provider registry;
- existing SQLite state remains compatible;
- existing bot commands and worker merge gates behave the same;
- test coverage exists for registry, adapters, classification, fallback, and worker fake-provider execution.

## Next immediate engineering task

Start with PR 1 only: provider types and registry, with tests, and no runtime behaviour change.

Recommended coding-agent prompt:

```text
Implement PR 1 of docs/implementation/next-phase-provider-adapter-plan.md.

Scope:
- Add ProviderAdapter types under src/providers/types.ts.
- Add a simple provider registry under src/providers/registry.ts.
- Add tests for provider lookup, unknown provider failure, and supported provider id validation.
- Do not change runtime bot or worker behaviour.
- Do not modify database schema.
- Do not introduce role/playbook/workflow abstractions.
- Keep the PR small and TDD-first.

Before coding, inspect existing provider/CLI routing code and align names with current provider identifiers.
Run tests and typecheck before opening the PR.
```
