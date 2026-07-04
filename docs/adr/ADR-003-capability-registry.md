# ADR-003 — Introduce Minimal Capability Registry

## Status

Accepted for minimal Epic 11 scope.

## Context

Agent Bridge needs a consistent way to describe available providers, tools, diagnostics, and risk boundaries.

External projects such as Agent-Reach demonstrate useful patterns around capability-based tool access and diagnostics, but full integration or broad internet tooling would be premature.

## Decision

Introduce a minimal Capability Registry.

The registry describes capabilities and readiness metadata. It is not a marketplace, plugin framework, browser automation layer, or broad internet tooling bundle.

## Minimal Scope

A capability may describe:

- id
- kind
- scope
- risk level
- required auth/config
- diagnostic status
- install hint
- preferred/fallback backends
- policy requirements

## Consequences

Positive:

- common vocabulary for providers and tools
- safer scope control between Companion Runtime and Engineering Worker
- foundation for doctor diagnostics
- easier future adoption of optional capabilities

Trade-offs:

- premature abstraction risk if overbuilt
- requires clear non-goals to prevent speculative implementation

## Non-Goals

Do not implement in Epic 11:

- full Agent-Reach integration
- browser automation
- third-party plugins
- marketplace concepts
- credential/cookie storage
- broad internet connector bundle
