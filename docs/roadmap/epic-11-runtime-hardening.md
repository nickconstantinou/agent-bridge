# Epic 11 — Runtime Architecture Hardening

## Status

Completed on 18 July 2026. This is now a historical roadmap.

Epic issue: #48 — `Epic 11 Runtime Architecture Hardening`

All linked task issues are complete. The implementation established the three-part OSS architecture, provider registry and selection seams, provider-owned error classification, boundary tests, architecture lint, and doctor diagnostics while preserving existing runtime behaviour.

Future work is tracked in later issues and roadmaps rather than by reopening this epic.

## Purpose

Epic 11 hardened Agent Bridge after Epic 1 by making the runtime boundaries explicit without triggering a broad rewrite.

The goal was to clarify the product architecture and introduce the minimum shared-runtime seams needed for future growth.

## Approved Architecture

```text
Agent Bridge OSS
├── Companion Runtime
│   └── Domain-agnostic conversational AI runtime
├── Engineering Worker
│   └── Software-engineering-only autonomous work engine
└── Shared Runtime
    └── Common runtime services consumed by both
```

## Task Issues

- #49 — Documentation boundary update
- #50 — Minimal capability registry
- #51 — Shared provider selection seam
- #52 — Boundary tests
- #53 — Doctor diagnostics
- #55 — Provider error classification extraction

## Scope

Epic 11 included only the high-value changes that reduced future coupling.

### Documentation Boundary Update

Update docs to consistently describe Agent Bridge OSS as:

```text
Companion Runtime + Engineering Worker + Shared Runtime
```

Do not rename systemd services or environment variables for this epic.

### Minimal Capability Registry

Introduce a small capability registry, not a plugin ecosystem.

The registry should support:

- register capability
- list capabilities
- lookup capability by id
- capability scope
- capability risk level
- diagnostic status
- preferred/fallback backend metadata

Initial capability examples may be static metadata only.

Do not implement browser automation, internet tooling, or a marketplace in Epic 11.

### Shared Provider Selection

Move duplicated provider/CLI routing concepts toward a shared abstraction that both Companion Runtime and Engineering Worker can consume.

This should preserve existing behavior.

### Boundary Tests

Add tests that prevent cross-contamination between products.

At minimum:

- Companion Runtime registry entries cannot require worker-only concepts.
- Worker-only capabilities are marked as worker-scoped.
- Provider fallback order remains deterministic.
- Unknown capabilities fail clearly.

### Doctor Diagnostics

Add `doctor`-style diagnostics for runtime readiness.

Initial checks should cover:

- provider command exists
- configured provider model/fallback chain is parseable
- required token/env entries are present where applicable
- capability registry can report missing/available status

## Explicit Non-Goals

Epic 11 did not implement:

- Agent-Reach integration
- browser automation
- WhatsApp
- Slack
- Matrix
- capability marketplace
- large source tree reorganization
- broad service/env renaming
- new autonomous engineering workflows
- platform billing or provisioning changes
- cookie/session scraping or credential storage

## Completion Criteria

Epic 11 completed the following:

- every Epic 11 task issue is complete
- docs clearly present the three-part OSS architecture
- active roadmap and research docs are separated
- minimal capability registry exists with tests
- provider selection has a shared-runtime seam
- doctor diagnostics exist for provider/capability readiness
- existing Telegram/Discord companion behavior remains supported
- existing Engineering Worker queue and merge gate remain supported
- no existing service names or env files were intentionally broken

## Implementation Rule

The epic followed the rule: choose the smallest change that clarifies the boundary and preserves existing behavior.

Research ideas were not promoted into implementation without a later architecture decision and roadmap update.

## References

- Documentation index: [`../README.md`](../README.md)
- Architecture overview: [`../architecture/overview.md`](../architecture/overview.md)
- Companion Runtime: [`../architecture/companion-runtime.md`](../architecture/companion-runtime.md)
- Engineering Worker: [`../architecture/engineering-worker.md`](../architecture/engineering-worker.md)
- Shared Runtime: [`../architecture/shared-runtime.md`](../architecture/shared-runtime.md)
- Capability registry architecture: [`../architecture/capability-registry.md`](../architecture/capability-registry.md)
