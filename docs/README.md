# Agent Bridge Documentation

Status: canonical documentation index.

Validated against: `main` at `23d06cfc3e098561ec21ce29880e60d1d146b7cc`.

## Authority order

When documents disagree, use this order:

1. `docs/adr/` — accepted architectural decisions.
2. `docs/architecture/` — current intended architecture.
3. `docs/roadmap/` — approved implementation work.
4. Operational guides — current operator procedures and runtime-specific guides.
5. Implementation records — completed spikes or implementation notes that explain why code looks the way it does.
6. `docs/research/` and root `*-research.md` files — research only unless promoted into a roadmap.
7. `docs/archive/` — historical context only.

Coding agents must not implement from research or archive documents unless the idea has been promoted through an ADR and an active roadmap.

## Status taxonomy

Use these labels when creating or updating docs:

| Status | Meaning |
|---|---|
| `authoritative` | Current source of truth for architecture, decisions, or operations. |
| `active-roadmap` | Approved implementation work. |
| `implemented-record` | Records completed work and verification; useful context, not a standing roadmap. |
| `partially-implemented` | Some claims match code; remaining content is planned, deferred, or stale. |
| `superseded-pointer` | Kept only to redirect readers to current docs. |
| `research-only` | Evaluation material; not approved implementation work. |
| `archived` | Historical context only. |
| `runtime-design` | Design doc for a runtime asset or behavior; check code before moving. |

## Recommended front matter

New significant docs should start with a small status block:

```yaml
---
status: authoritative | active-roadmap | implemented-record | partially-implemented | superseded-pointer | research-only | archived | runtime-design
type: architecture | adr | roadmap | operations | research | archive | implementation-record | runtime-design
authority: canonical | advisory | historical | none
implementation_status: implemented | partially-implemented | planned | deferred | rejected | superseded | not-applicable
last_validated_against: <commit-sha>
---
```

## Current map

| Path | Classification | Authority | Notes |
|---|---|---|---|
| `docs/adr/ADR-001-oss-product-split.md` | authoritative | canonical | Accepted OSS product split. |
| `docs/adr/ADR-002-shared-runtime.md` | authoritative | canonical | Accepted Shared Runtime decision. |
| `docs/adr/ADR-003-capability-registry.md` | authoritative | canonical | Accepted minimal Epic 11 registry decision. |
| `docs/adr/ADR-004-engineering-worker-boundary.md` | authoritative | canonical | Accepted software-engineering-only worker boundary. |
| `docs/architecture/overview.md` | authoritative | canonical | Top-level architecture and documentation hierarchy. |
| `docs/architecture/companion-runtime.md` | authoritative | canonical | Companion Runtime boundary. |
| `docs/architecture/engineering-worker.md` | authoritative | canonical | Engineering Worker boundary. |
| `docs/architecture/shared-runtime.md` | authoritative | canonical | Shared Runtime boundary. |
| `docs/architecture/capability-registry.md` | active architecture | canonical for intended design | Scope controlled by Epic 11 roadmap. |
| `docs/architecture/platform-boundary.md` | authoritative | canonical | OSS/platform ownership boundary. |
| `docs/architecture/01-current-architecture.md` | implemented-record | advisory | Snapshot audit; useful evidence, not higher than newer ADRs. |
| `docs/architecture/02-gap-analysis.md` | partially-implemented | advisory | Backlog/gap list; revalidate before building. |
| `docs/architecture/03-target-architecture.md` | partially-implemented | advisory | Target architecture, not a rewrite instruction. |
| `docs/roadmap/epic-11-runtime-hardening.md` | active-roadmap | canonical | Only approved Epic 11 implementation plan. |
| `docs/WORKER-GUIDE.md` | authoritative operations | canonical for worker use | Current worker operator guide. |
| `docs/SAFE-RESTART.md` | authoritative operations | canonical for safe restart helper | Referenced by `AGENTS.md` restart policy. |
| `docs/PRD.md` | partially-implemented product reference | advisory | Broad product/architecture reference; defer to ADRs and architecture docs on conflicts. |
| `docs/soul.md` | runtime-design | advisory/canonical for SOUL.md behavior | Documents root `SOUL.md` runtime injection; the doc itself is not the default loaded file. |
| `docs/agent-driven-memory-research.md` | implemented-record | advisory | Phases 1-4 implemented; retains research/verification history. |
| `docs/bridge-event-normalization-research.md` | implemented-record plus deferred research | advisory | Phases 1-5 completed; Phase 6 deferred. |
| `docs/discord-compatibility-research.md` | implemented-record plus follow-up checklist | advisory | Discord baseline implemented; operational hardening remains. |
| `docs/health-bolt-architecture.md` | implemented-record | advisory | Shared-engine health architecture implemented. |
| `docs/health-monitor-rectification.md` | implemented-record/checklist | advisory | Rectification mostly complete; monitor follow-up remains. |
| `docs/native-telegram-layout-spike.md` | partially-implemented / partially-superseded | advisory | Status should be refreshed: rich-message table path still exists opportunistically. |
| `docs/prompt-optimization-loop-research.md` | implemented-record plus stale research notes | advisory | Referenced by `AGENTS.md`; earlier `src/agentMemory.ts` note is stale. |
| `docs/antigravity-agent-view-spike.md` | research-only | none | Spike complete; no default background-mode implementation. |
| `docs/claude-agent-view-spike.md` | research-only | none | Background mode rejected as default; optional future idea only. |
| `docs/cursor-agent-spike-research.md` | rejected research | none | Not viable as backend. |
| `docs/cursor-sdk-spike-research.md` | conditional research | none | Potential future backend only with API key and shim; not current roadmap. |
| `docs/autonomous-agent-bridge-research.md` | superseded-pointer | none | Redirects to worker guide, active roadmap, research, and archive. |
| `docs/oss-product-split-plan.md` | superseded-pointer | none | Redirects to Epic 11 roadmap, research, and archive. |
| `docs/research/future-runtime-evolution.md` | research-only | none | Deferred ideas; promotion rules apply. |
| `docs/archive/autonomous-agent-bridge-research-v1.md` | archived | none | Historical context only. |
| `docs/archive/oss-product-split-plan-v1.md` | archived | none | Historical context only. |

## Runtime dependency notes

- `docs/soul.md` is a design document. Runtime loading is handled by `src/soul.ts`, which defaults to `<project>/SOUL.md` or `AGENT_BRIDGE_SOUL_PATH`.
- `docs/prompt-optimization-loop-research.md` is referenced by `AGENTS.md` for optimizer methodology. It is not loaded by runtime services.
- `docs/WORKER-GUIDE.md` and `docs/SAFE-RESTART.md` are operational docs. They are not loaded by services but are authoritative for operator behavior.
- Superseded pointer files should stay until inbound references are cleaned up, then they can move fully into `docs/archive/`.

## Reorg rule

Do not move or archive a document until `docs/DOCUMENTATION-AUDIT.md` classifies it and confirms whether code, tests, `AGENTS.md`, README, or systemd/operator flows still reference it.
