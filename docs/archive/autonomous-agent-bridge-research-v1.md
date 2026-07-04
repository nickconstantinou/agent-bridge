# Archive — Autonomous Agent Bridge Research v1

## Status

Archived. Historical context only.

This file records that the original long-form autonomous-worker research note has been superseded as an implementation guide.

The live implementation state is still documented in the worker guide:

- `docs/WORKER-GUIDE.md`

The active roadmap is now:

- `docs/roadmap/epic-11-runtime-hardening.md`

Deferred runtime and external-project ideas are now tracked in:

- `docs/research/future-runtime-evolution.md`

## Historical Scope

The original document covered the evolution from Telegram CLI wrapper to policy-gated engineering worker, including:

- durable work schema
- job leasing and heartbeats
- Telegram worker commands
- defect scans
- feature planning
- GitHub issue creation
- TDD implementation jobs
- PR lifecycle and merge gate
- PR caps, CI reaction, stale digest
- planned maintainer queue triage

## Superseded Roadmap Status

The old document included roadmap-like phase language. That phase list should no longer drive new implementation.

For Epic 11, implementation agents must use only:

- `docs/roadmap/epic-11-runtime-hardening.md`

## Do Not Implement From This File

This archived note must not be used as an implementation source by coding agents.

If a future worker feature from the old research note is still valuable, it must be promoted into a new active roadmap document first.
