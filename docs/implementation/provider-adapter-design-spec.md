# Provider Adapter Design Spec

## Purpose

This document turns the next-phase implementation plan into a concrete implementation specification for the first Provider Adapter workstream.

It is documentation-only. It should be merged before implementation so the coding agent has a stable contract to follow.

## Current problem

Agent Bridge currently supports multiple CLI providers, but provider-specific behaviour is at risk of spreading across bot entrypoints, CLI routing, fallback handling, worker orchestration, and error classification.

That makes future changes harder because every new provider or provider-specific failure mode can require touching unrelated runtime paths.

The next phase introduces a narrow Provider Adapter boundary. The boundary should isolate provider-specific details while preserving current runtime behaviour.

## Scope for the first implementation PR

The first implementation PR must be deliberately small.

It should add only:

- provider id types;
- provider adapter interfaces;
- a static provider registry;
- unit tests for registry behaviour;
- no runtime caller migration.

It must not:

- change Telegram behaviour;
- change Discord behaviour;
- change worker behaviour;
- change SQLite schema;
- introduce workflow/playbook/role abstractions;
- move provider command construction yet;
- alter fallback semantics.

## Provider ids

Use explicit provider ids. Do not use arbitrary strings in new code.

Initial ids:

```ts
export const PROVIDER_IDS = ['codex', 'claude', 'agy'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
```

Rationale:

- `codex` maps to OpenAI Codex CLI behaviour already present in the project.
- `claude` maps to Claude CLI behaviour.
- `agy` maps to Agy/Antigravity behaviour. Keep the id short and stable even if display names change.

Do not introduce `antigravity` as a separate id unless the runtime already has a separate provider mode for it.

## Minimal interface

The first interface should define the shape but not force immediate runtime migration.

```ts
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly executable: string;
  readonly defaultArgs: readonly string[];
  readonly capabilities: ProviderCapabilities;
}

export interface ProviderCapabilities {
  readonly interactive: boolean;
  readonly worker: boolean;
  readonly fallbackTarget: boolean;
}
```

Do not include process-spawn implementation methods in PR 1 unless current tests require them. The first PR is about establishing the typed boundary and registry.

## Future interface extension

The next PRs may extend the interface with invocation and error classification.

Expected future shape:

```ts
export interface ProviderInvocationInput {
  readonly prompt: string;
  readonly workingDirectory?: string;
  readonly sessionId?: string;
  readonly environment?: Record<string, string>;
}

export interface ProviderInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
  readonly stdin?: string;
}

export type ProviderErrorClassification =
  | { readonly kind: 'capacity_exhausted'; readonly reason: string }
  | { readonly kind: 'auth_required'; readonly reason: string }
  | { readonly kind: 'model_unavailable'; readonly reason: string }
  | { readonly kind: 'transient'; readonly reason: string }
  | { readonly kind: 'fatal'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string };
```

These should not be wired into live runtime until adapter parity tests exist.

## Registry contract

The registry should be static and deterministic.

Expected API:

```ts
export function getProviderAdapter(id: ProviderId): ProviderAdapter;
export function getProviderAdapters(): readonly ProviderAdapter[];
export function isProviderId(value: string): value is ProviderId;
export function assertProviderId(value: string): ProviderId;
```

Behaviour:

- `getProviderAdapter('codex')` returns the Codex adapter metadata.
- `getProviderAdapters()` returns all registered adapters in stable order.
- `isProviderId('codex')` returns true.
- `isProviderId('unknown')` returns false.
- `assertProviderId('unknown')` throws a clear error listing valid ids.

Avoid mutable registration for now. Dynamic plugins are not part of this phase.

## Suggested file layout

```text
src/providers/
  types.ts
  registry.ts

test/
  providers.registry.test.ts
```

Do not create `src/providers/index.ts` unless import ergonomics clearly require it.

## Adapter metadata defaults

Initial metadata can be conservative. It should match existing provider availability as closely as possible without changing behaviour.

Recommended starting point:

```ts
const CODEX_ADAPTER: ProviderAdapter = {
  id: 'codex',
  displayName: 'Codex',
  executable: 'codex',
  defaultArgs: [],
  capabilities: {
    interactive: true,
    worker: true,
    fallbackTarget: true,
  },
};
```

For Claude and Agy, inspect existing runtime code before setting capabilities. If uncertain, preserve current behaviour by setting metadata only and do not consume it from runtime yet.

## Testing requirements for PR 1

Tests must be written before implementation.

Required tests:

1. `getProviderAdapters` returns all initial providers.
2. `getProviderAdapter` returns the expected adapter for each known id.
3. `isProviderId` accepts known ids.
4. `isProviderId` rejects unknown strings.
5. `assertProviderId` returns a typed id for known strings.
6. `assertProviderId` throws a helpful error for unknown strings.
7. returned adapter list cannot mutate the internal registry.

Suggested test assertions:

```ts
expect(getProviderAdapter('codex').id).toBe('codex');
expect(isProviderId('claude')).toBe(true);
expect(isProviderId('bogus')).toBe(false);
expect(() => assertProviderId('bogus')).toThrow(/codex.*claude.*agy/);
```

## Acceptance criteria for PR 1

PR 1 is complete when:

- provider types exist;
- provider registry exists;
- registry tests pass;
- typecheck passes;
- no runtime files outside `src/providers` are modified unless needed for exports;
- no bot, worker, database, or CLI behaviour changes;
- no new environment variables are required.

## Review checklist

Reviewers should reject PR 1 if it:

- changes runtime routing;
- changes command spawning;
- changes fallback behaviour;
- changes worker execution;
- introduces dynamic plugin loading;
- adds role/playbook/workflow abstractions;
- adds database migrations;
- uses untyped provider strings in new code.

## Follow-on documentation before coding PR 2

Before extracting error classification, add or update documentation covering:

- known capacity exhaustion messages by provider;
- known auth failures by provider;
- known transient failures by provider;
- negative examples that must not be classified as capacity exhaustion.

That prevents broad error matching from regressing again.
