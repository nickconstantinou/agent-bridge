# Agent Bridge OSS Product Split Plan

## Status

Accepted as the architectural direction after Epic 1. This plan reframes the OSS as two products that share one runtime rather than one worker-centric system.

- Completed foundation: Epic 1 / existing interactive and worker runtime foundations.
- Next roadmap focus: Epic 11 should preserve this split and avoid moving general-purpose agent capabilities into the engineering worker.
- Source-of-truth relationship: this document updates the roadmap direction; implementation still proceeds through small TDD changes.

## Mission

Agent Bridge is an open-source runtime for autonomous AI agents.

It consists of:

1. a domain-agnostic Companion Runtime for conversational AI agents, and
2. a specialized Engineering Worker for autonomous software development.

Both consume a shared runtime that provides provider abstraction, session state, memory, eventing, capability management, notifications, authentication, secrets, and operational telemetry.

The hosted Agent Bridge Platform provisions, manages, bills, and monitors Agent Bridge deployments. Autonomous execution remains inside the OSS runtime.

## Product Boundary

```text
Agent Bridge OSS
├── Companion Runtime
│   └── Domain-agnostic conversational agent interface
├── Engineering Worker
│   └── Software-engineering-only autonomous work engine
└── Shared Runtime
    └── Common services consumed by both products
```

### Companion Runtime

The Companion Runtime is not an engineering worker and should not know about Git, pull requests, CI, TDD, repository queues, or merge approvals.

Its job is to expose one or more AI runtimes through conversational surfaces:

- Telegram
- Discord
- future WhatsApp
- future Slack
- future Matrix
- future TUI

Core flow:

```text
Transport
→ Conversation router
→ Provider selection
→ Session management
→ Usage monitoring
→ Fallback
→ Memory
→ Capability/tool execution
→ Response
```

Supported use cases include:

- summarize a meeting
- research a topic
- translate a document
- plan a holiday
- draft a blog post
- explain infrastructure or code concepts
- use browser/search/content capabilities through the shared capability registry

### Engineering Worker

The Engineering Worker is an autonomous engineering engine, not a chatbot and not a general-purpose agent framework.

Everything in this subsystem assumes software engineering:

```text
Work item
→ Planning
→ Architecture review
→ TDD
→ Implementation
→ Testing
→ Review
→ Repair
→ PR
→ CI
→ Reviewer comments
→ Merge approval
```

It owns:

- repositories
- disposable clones / worktrees
- Git
- CI state
- GitHub issue and PR lifecycle
- review workflows
- architecture/refactor checks
- release-oriented engineering automation

The hard invariant remains: nothing merges and no destructive operation happens without explicit human approval.

### Shared Runtime

Shared runtime services must be dependency-inverted so both products consume them without inheriting each other's domain model.

Shared services:

- SQLite persistence
- Event bus / audit events
- Memory
- Provider adapters
- CLI management
- Authentication / authorization
- Secrets
- Notifications
- Metrics / health
- Capability registry
- Policy evaluation

The Engineering Worker may consume general capabilities, but it should do so through explicit worker policies. The Companion Runtime may consume the same capabilities without gaining engineering concepts.

## Capability Registry Direction

Agent Bridge should introduce a first-class capability registry that describes what the runtime can do and how each capability is installed, diagnosed, routed, and invoked.

Initial capability families:

```text
AI providers:
- Codex
- Claude
- Antigravity / Gemini

Content and research:
- Browser / web reader
- Search
- RSS
- GitHub read/search
- YouTube transcript/search
- Reddit / social readers where locally configured

Execution:
- Filesystem
- Terminal
- Docker
- Kubernetes

Engineering:
- Git
- GitHub issue/PR writes
- Test runner
- CI checks
```

Each capability should define:

- `id`
- `kind`
- `scope` (`companion`, `worker`, or `shared`)
- `risk_level`
- `requires_auth`
- `requires_user_login_state`
- `diagnose()`
- `install_hint`
- `preferred_backends`
- `fallback_backends`
- `policy_required`

This allows both products to share detection and routing without duplicating tool setup logic.

## Agent-Reach Evaluation

Agent-Reach is most relevant to the Companion Runtime and the shared capability registry, not to the Engineering Worker core loop.

Useful ideas to adopt:

- Treat internet/tool access as a capability layer, not as ad hoc commands embedded in prompts.
- Maintain ordered primary/fallback backends per channel.
- Add a `doctor` style diagnostic command that checks each capability and gives actionable repair guidance.
- Prefer local user login state for services that require authentication, rather than centralizing cookies or credentials in Agent Bridge.
- Keep installation guidance agent-readable so a CLI agent can install or repair optional capabilities.
- Distinguish read/content capabilities from browser action/automation capabilities.

Ideas not to copy blindly:

- Do not make Companion Runtime depend on every optional internet capability.
- Do not let social/web research features leak into the Engineering Worker domain model.
- Do not store exported cookies or sensitive login material in Agent Bridge SQLite.
- Do not make hosted platform provisioning responsible for bypassing platform restrictions or owning user login state.

Layer mapping:

| External influence | Primary Agent Bridge layer | Adopted lesson |
|---|---|---|
| Agent-Reach | Companion Runtime / Capability Registry | Capability installation, diagnostics, internet/content access, backend fallback |
| Agent Orchestrator | Engineering Worker | Parallel sessions, worktree/workspace orchestration, feedback routing |
| gstack | Engineering Worker workflows | Planning discipline, review methodology, QA and release process |

## Platform Impact

The hosted platform installs and manages Agent Bridge OSS, but does not own the autonomous execution model.

Platform responsibilities:

- provisioning
- deployment lifecycle
- workspace management
- auth
- billing
- monitoring
- upgrades

A workspace may enable:

- Companion Runtime only
- Engineering Worker only
- both

The control plane should see these as runtime modules/capabilities, not as separate platform products.

## Roadmap Update

Epic 11 should be treated as the product-boundary and shared-runtime hardening epic before more autonomous worker features are added.

Recommended Epic 11 scope:

1. Rename architecture language from `interactive bot` / `companion bot` toward `Companion Runtime` where appropriate.
2. Keep existing service names stable for compatibility, but introduce internal module boundaries:
   - `runtime/companion`
   - `runtime/worker`
   - `runtime/shared`
   - `runtime/capabilities`
3. Define the capability registry interface and add tests around registration, diagnosis, and policy scoping.
4. Move provider/CLI selection into shared runtime abstractions consumed by both Companion Runtime and Engineering Worker.
5. Ensure worker-only concepts remain worker-only:
   - repositories
   - work items
   - PRs
   - CI
   - TDD
   - merge approvals
6. Add documentation that makes the OSS/platform boundary explicit.
7. Add `doctor`-style checks for provider commands and optional capabilities.

Out of scope for Epic 11:

- Full Agent-Reach integration.
- WhatsApp/Slack/Matrix implementation.
- Browser automation beyond capability interface stubs.
- New autonomous engineering workflows beyond those already planned.
- Platform billing/provisioning changes except documentation alignment.

## Acceptance Criteria

Epic 11 is complete when:

- Documentation clearly presents Agent Bridge OSS as Companion Runtime + Engineering Worker + Shared Runtime.
- Companion Runtime docs do not imply GitHub/TDD/CI responsibilities.
- Engineering Worker docs do not imply general-purpose conversational-agent responsibilities.
- Shared runtime interfaces exist for provider selection, memory, notifications, and capability registration.
- Capability registry has unit tests for registration, lookup, diagnosis status, risk scope, and fallback order.
- Existing Telegram/Discord interactive behavior still works.
- Existing worker queue and merge-gate behavior still works.
- No existing systemd service names or env files are broken by the refactor.
