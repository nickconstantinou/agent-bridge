# Epic 11 — Runtime Architecture Hardening

## Status

Active roadmap. Execution is tracked in GitHub issues, not in this document.

Epic issue: #48 — `Epic 11 Runtime Architecture Hardening`

This document is the durable roadmap index for Epic 11. Keep implementation discussion, ownership, status, and PR linkage in the linked GitHub issues.

Everything outside this document is research, historical context, or future consideration unless it is promoted by a later architecture decision and roadmap update.

## Purpose

Epic 11 hardens Agent Bridge after Epic 1 by making the runtime boundaries explicit without triggering a broad rewrite.

The goal is to clarify the product architecture and introduce the minimum shared-runtime seams needed for future growth.

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

## Scope

Epic 11 includes only the high-value changes that reduce future coupling.

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

Epic 11 must not implement:

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

## Acceptance Criteria

Epic 11 is complete when:

- every Epic 11 task issue is complete
- docs clearly present the three-part OSS architecture
- active roadmap and research docs are separated
- minimal capability registry exists with tests
- provider selection has a shared-runtime seam
- doctor diagnostics exist for provider/capability readiness
- existing Telegram/Discord companion behavior still works
- existing Engineering Worker queue and merge gate still work
- no existing service names or env files are broken

## Implementation Rule

When in doubt, choose the smallest change that clarifies the boundary and preserves existing behavior.

Do not promote research ideas into implementation during Epic 11.

## References

- Documentation index: [`../README.md`](../README.md)
- Architecture overview: [`../architecture/overview.md`](../architecture/overview.md)
- Companion Runtime: [`../architecture/companion-runtime.md`](../architecture/companion-runtime.md)
- Engineering Worker: [`../architecture/engineering-worker.md`](../architecture/engineering-worker.md)
- Shared Runtime: [`../architecture/shared-runtime.md`](../architecture/shared-runtime.md)
- Capability registry architecture: [`../architecture/capability-registry.md`](../architecture/capability-registry.md)
