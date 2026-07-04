# ADR-002 — Introduce Shared Runtime

## Status

Accepted.

## Context

Companion Runtime and Engineering Worker both need common infrastructure: provider selection, CLI handling, SQLite-backed state, memory, notifications, metrics, diagnostics, and capability metadata.

Duplicating these concepts creates operational drift. Putting product-specific domain logic into common code creates coupling.

## Decision

Introduce Shared Runtime as the common infrastructure layer consumed by both products.

Shared Runtime must remain domain-neutral. It may expose interfaces and metadata, but product-specific workflows remain in the relevant product layer.

## Consequences

Positive:

- less duplicated provider/fallback logic
- consistent diagnostics and capability reporting
- cleaner future platform integration
- easier testing of cross-product services

Trade-offs:

- Shared Runtime boundaries must be guarded carefully
- not every common-looking concern belongs in Shared Runtime

## Implementation Guidance

Epic 11 should introduce small seams rather than a broad rewrite.

Shared Runtime should not own worker work items, PR state, CI lifecycle, or transport command behavior.
