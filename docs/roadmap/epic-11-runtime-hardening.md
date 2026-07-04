# Epic 11 — Runtime Architecture Hardening

## Status

Active roadmap. This is the only approved implementation plan for Epic 11.

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

## Product Boundaries

### Companion Runtime

The Companion Runtime is the domain-agnostic conversational runtime.

It owns:

- Telegram conversational surfaces
- Discord conversational surfaces
- future chat/TUI transports
- conversation routing
- provider selection
- session management
- usage monitoring
- fallback
- memory use
- response delivery

It must not own or depend on worker-only concepts:

- repositories
- work items
- Git branches
- pull requests
- TDD
- CI
- merge approvals

### Engineering Worker

The Engineering Worker is software-engineering-only.

It owns:

- repository resolution
- disposable clones / workspaces
- work items and jobs
- planning for software changes
- TDD implementation
- test and verification commands
- Git and GitHub issue/PR lifecycle
- CI reaction
- review repair
- merge approval gates

It must not become a general-purpose conversational agent framework.

### Shared Runtime

Shared Runtime provides common services used by both products.

Approved shared areas for Epic 11:

- provider / CLI selection
- session persistence boundaries
- notifications
- memory access seams
- minimal capability registry
- diagnostics

## Scope

Epic 11 includes only the high-value changes that reduce future coupling.

### 1. Documentation Boundary Update

Update docs to consistently describe Agent Bridge OSS as:

```text
Companion Runtime + Engineering Worker + Shared Runtime
```

Do not rename systemd services or environment variables for this epic.

### 2. Minimal Capability Registry

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

### 3. Shared Provider Selection

Move duplicated provider/CLI routing concepts toward a shared abstraction that both Companion Runtime and Engineering Worker can consume.

This should preserve existing behavior.

### 4. Boundary Tests

Add tests that prevent cross-contamination between products.

At minimum:

- Companion Runtime registry entries cannot require worker-only concepts.
- Worker-only capabilities are marked as worker-scoped.
- Provider fallback order remains deterministic.
- Unknown capabilities fail clearly.

### 5. Doctor Diagnostics

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
