# 04 — Architecture Decision Records

Format: Context → Decision → Consequences → Status.

## ADR-001: ProviderAdapter interface over BotKind branching
- **Context:** Kimchi integration required edits across provider-specific branches.
- **Decision:** One ProviderAdapter per CLI, registered centrally. Adapters own invocation, parsing, sessions, error classification, effort, timeouts, capabilities, and probes.
- **Consequences:** Provider additions become registry-driven and provider errors remain scoped.
- **Status:** Accepted and progressively implemented.

## ADR-002: Event-aware worker lifecycle
- **Context:** Worker lifecycle needs durable history and restart evidence.
- **Decision:** Lifecycle events and authoritative state transitions share one owned persistence boundary; current status remains queryable without treating model output as truth.
- **Consequences:** Replay, diagnostics, and ownership checks are possible without an external broker.
- **Status:** Partially implemented; coordinated with Issue #119.

## ADR-003: Declarative workflow definitions
- **Context:** Feature, defect, refactor, documentation, and release paths share gates and execution steps.
- **Decision:** Preserve a workflow/handler seam that can express reusable steps and policies without a broad rewrite.
- **Consequences:** New workflows reuse requirements, planning, execution, documentation, and approval boundaries.
- **Status:** Proposed incrementally; role orchestration extends the current handler map first.

## ADR-004: SQLite stays; no external broker
- **Context:** Single-host/workspace deployment and synchronous locking make external infrastructure unjustified.
- **Decision:** Keep SQLite and narrow repository ownership.
- **Consequences:** Horizontal scale remains deferred; process-per-workspace remains valid.
- **Status:** Accepted.

## ADR-005: GitHub issues as record of truth for external intake
- **Context:** Externally created issues must be importable and reconciled.
- **Decision:** GitHub is authoritative for external issue content and closure; SQLite remains authoritative for execution state.
- **Consequences:** Canonical validated issue versions and reconciliation rules must be explicit.
- **Status:** Accepted direction and implemented in stages.

## ADR-006: OSS/platform boundary through stable APIs
- **Context:** Provisioning and hosted controls must not import or bypass OSS internals.
- **Decision:** Platform configures and observes workspaces through stable boundaries; OSS owns autonomous execution.
- **Consequences:** Role allocation belongs in platform configuration, while role enforcement remains in OSS.
- **Status:** Accepted direction.

## ADR-007: Strict TDD with architectural acceptance criteria
- **Context:** Tests can pass while missing architectural intent.
- **Decision:** Behaviour changes start with failing acceptance/boundary tests and Architecture Lint enforces durable ownership rules.
- **Consequences:** Structural intent fails CI rather than relying only on review.
- **Status:** Accepted and implemented.

## ADR-008: Companion Runtime, Engineering Worker, and Shared Runtime
- **Context:** Conversational and engineering-specific concerns need explicit boundaries.
- **Decision:** Companion and Engineering Worker are separate products over Shared Runtime services.
- **Consequences:** Worker-specific Git, GitHub, CI, and lifecycle behaviour does not leak into the companion runtime.
- **Status:** Accepted.

## ADR-009: Role-based agentic orchestration
- **Context:** Scribe-led planning assumes complete inputs and assigns requirements/planning to a provider chain that does not express responsibility, permissions, or model capability. PR #157 exposed repeated structural non-compliance in the plan-authoring path.
- **Decision:** Expose exactly three configurable roles: Technical Lead, Code Worker, and Documentation Steward. The Technical Lead uses the strongest read-only advisor path for requirements, canonical issues, planning, guidance, review, operations, and readiness. Scanner is a Code Worker mode; reviewer and operations are Technical Lead modes. Agent Bridge remains authoritative.
- **Consequences:** Role/model configuration, capability discovery, permission profiles, canonical requirements, documentation triggers, lifecycle integration, degraded single-provider status, and platform UI are required. Legacy chains become explicit compatibility inputs.
- **Status:** Accepted. Full record: `docs/decisions/ADR-009-role-based-agentic-orchestration.md`.