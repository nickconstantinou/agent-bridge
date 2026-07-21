---
name: risk-based-test-strategy
description: Use when deciding what tests or checks a software change needs based on blast radius, user impact, integration boundaries, regression risk, and existing coverage.
---

# Risk Based Test Strategy

Use this skill when planning or reviewing test coverage for a change.

<!-- BEGIN AGENT_BRIDGE_RUNTIME_GUIDANCE -->
## Risk Scan

Consider:

- User-visible behavior
- Persistence, migrations, and data shape changes
- Auth, permissions, billing, security, and privacy impact
- External APIs, queues, webhooks, and background jobs
- Shared libraries or cross-module contracts
- Prior bug history and fragile areas

## Match Risk To Checks

- Low-risk local logic: focused unit tests may be enough.
- Behavior changes: add tests around the observable contract.
- Bug fixes: add a regression test that fails before the fix.
- Integration boundaries: add integration or contract coverage.
- Critical user paths: add end-to-end or manual verification.
- Operational risk: add logs, metrics, alerts, or runbook notes when appropriate.

Prefer the narrowest test that would catch the failure, then add broader checks only when the risk crosses a boundary.

## Final Verification

Before finishing, name what was tested, what was not tested, and the residual risk.
<!-- END AGENT_BRIDGE_RUNTIME_GUIDANCE -->
