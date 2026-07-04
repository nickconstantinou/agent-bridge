# Future Runtime Evolution Research

## Status

Research only. Not an implementation roadmap.

These ideas are intentionally deferred. They must not be implemented by coding agents unless they are promoted through a future architecture decision and an active roadmap document.

## Promotion Rule

A research item may move into implementation only when all are true:

1. A concrete user or operator need exists.
2. The idea has an owner and success criteria.
3. The architecture impact is documented.
4. The item is added to an active roadmap.
5. Existing runtime boundaries remain intact.

## Deferred Ideas

### Agent-Reach Influence

Agent-Reach is useful as research for the Companion Runtime and the Shared Runtime capability model.

Potentially useful ideas:

- capability-based internet/tool access
- ordered primary/fallback backends
- install and repair guidance
- doctor diagnostics
- distinguishing read-only content access from browser/action automation
- local user-login-state assumptions for tools that require authentication

Deferred until adoption is justified:

- full Agent-Reach integration
- large internet capability bundle
- browser automation
- web/social/media-specific capability implementations
- any credential/cookie handling model

### Advanced Capability Ecosystem

Research topics:

- dynamic plugin loading
- third-party capability packages
- capability marketplace
- remote capability execution
- per-workspace capability policy
- capability sandboxing

Deferred because Epic 11 only needs a minimal registry.

### Additional Transports

Research topics:

- WhatsApp
- Slack
- Matrix
- TUI
- web UI conversation surface

Deferred because Telegram and Discord already validate the runtime model.

### Large Source Tree Reorganization

Research topics:

- moving code into `runtime/companion`
- moving code into `runtime/worker`
- moving shared services into `runtime/shared`
- splitting packages

Deferred because broad file movement creates churn without immediate user value.

Epic 11 may introduce small seams, but not a large directory rewrite.

### Advanced Engineering Worker Influences

Agent Orchestrator and gstack remain useful research for the Engineering Worker.

Potential areas:

- parallel worktree sessions
- advanced reviewer feedback routing
- stricter planning/review templates
- release workflow automation
- QA gates beyond current tests/CI

Deferred until the current worker lifecycle is stable under real use.

## What Must Not Leak Into Implementation

Future coding agents must not infer approval to build:

- browser automation
- social/research connectors
- new transports
- broad plugin architecture
- marketplace concepts
- major runtime restructuring
- worker features unrelated to the active roadmap

This document preserves ideas without making them commitments.
