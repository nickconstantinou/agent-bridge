# 03 — Target Architecture

Evolution of the existing codebase, not a rewrite. Every layer maps to existing boundaries or an approved extension.

## Mission

> Agent Bridge is an open-source runtime for autonomous AI agents. It consists of a domain-agnostic Companion Runtime for conversational agents and a specialised Engineering Worker for software development. Both share provider abstraction, memory, eventing, capability management, configuration, persistence, and process supervision. The hosted platform provisions and configures workspaces; autonomous execution remains in OSS.

## Two products, one shared runtime

```text
                Agent Bridge OSS
                       │
      ┌────────────────┴────────────────┐
      │                                 │
Companion Runtime              Engineering Worker
(domain-agnostic)              (software engineering only)
      │                                 │
conversation routing           validated issue workflows
provider/model selection       Technical Lead orchestration
sessions and memory            Code Worker TDD execution
responses and tools            Documentation Steward lane
      └────────────────┬────────────────┘
                Shared Runtime
  SQLite repositories · provider adapters · advisor service ·
  capability policy · config · memory · notifications · metrics ·
  process supervision · lifecycle ownership
```

Companion modules never import worker modules and vice versa; both depend on Shared Runtime boundaries.

## Engineering Worker role architecture

The platform exposes exactly three role assignments:

```text
Technical Lead
  requirements → issue validation/authoring → planning
  → guidance → implementation review → operations review → readiness
  read-only advisor evidence boundary

Code Worker
  scan/investigate (read-only)
  → red/green/repair/verify (mode-specific worktree permissions)

Documentation Steward
  impact/validate (read-only)
  → author/maintenance (documentation-only mutation)
```

Scanner is a Code Worker mode. Reviewer and operations are Technical Lead modes.

Agent Bridge owns all workflow transitions, role resolution, permissions, budgets, validation, retries, cancellation, approvals, merge, deployment, and audit.

## Worker lifecycle

```text
Raw feature request, imported issue, or scan finding
→ classify feature | defect | refactor
→ Technical Lead gathers or validates requirements
→ canonical issue
→ requirements_ready
→ Technical Lead authors implementation plan and execution contract
→ Documentation Steward impact assessment
→ approval when policy requires it
→ Code Worker TDD implementation in a disposable workspace
→ deterministic verification
→ Technical Lead implementation and operations review
→ Documentation Steward updates and validation
→ PR readiness
→ draft PR, CI, reviewer feedback
→ human merge gate
```

Incoming issues and scan findings are not trusted as complete specifications. Repository facts are gathered through typed, allowlisted, bounded read-only tools. Product decisions are surfaced to a human.

## Role and model assignment

A role binds an authenticated CLI, explicit model, fallbacks, permissions, budgets, and output contracts. The platform supports automatic, recommended, and manual assignment.

A single authenticated CLI can provide different models to each role. A single model can provide every role with isolated sessions and permissions, while status reports that model diversity and independent-model review are unavailable.

## Layer diagram

```text
┌──────────────────────── Interfaces ─────────────────────────┐
│ Telegram/Discord · Worker commands · Platform role settings │
├──────────────────── Worker orchestration ───────────────────┤
│ Intake and requirements · workflow state · role resolver    │
│ issue/plan validators · documentation triggers · approvals  │
├────────────────── Role execution boundaries ────────────────┤
│ Technical Lead via AdvisorService and read-only tools       │
│ Code Worker via workspace and mode permission policy        │
│ Documentation Steward via documentation-only path policy    │
├──────────────────────── Providers ───────────────────────────┤
│ ProviderAdapter registry · model discovery/probes/fallback  │
├──────────────────────── Runtime ─────────────────────────────┤
│ Workspaces · supervisor · event/lifecycle ownership · memory│
├────────────────────── Persistence ───────────────────────────┤
│ SQLite via owning repositories · jobs · roles · audit       │
└─────────────────────────────────────────────────────────────┘
 Platform: authentication, provisioning, role/model allocation,
 effective status, and policy UI; no direct worker authority.
```

## Key decisions

1. Provider adapters and capability metadata remain registry-driven.
2. SQLite remains the local authoritative store; repositories own SQL.
3. Agent Bridge, not a model, is the workflow engine and authority.
4. The advisor path is the Technical Lead execution boundary.
5. Canonical requirements precede planning for feature, defect, and refactor paths.
6. Code mutation remains bounded by existing disposable workspaces and TDD guards.
7. Documentation is a first-class readiness obligation driven by `agentic-maintenance.yaml`.
8. Role identity is independent of CLI/provider identity.
9. Single-provider operation is supported with explicit degradation reporting.
10. GitHub is authoritative for externally authored issue content where configured; SQLite remains authoritative for execution state.
11. Platform and OSS communicate through stable configuration/status boundaries; platform cannot bypass OSS policy.

## Canonical references

- `docs/architecture/engineering-worker.md`
- `docs/architecture/agentic-worker-orchestration.md`
- `docs/agentic-maintenance.md`
- `docs/decisions/ADR-009-role-based-agentic-orchestration.md`
- `docs/configuration/agent-role-assignment.md`
- `docs/operations/agentic-worker-runbook.md`
- `docs/testing/agentic-worker-verification.md`
- `agentic-maintenance.yaml`

## Guardrail

Do not turn this into an unrestricted engineering operating system or a free-form model-to-model loop. Every model call has one role, one mode, one bounded contract, one permission profile, one owner, and one auditable transition.