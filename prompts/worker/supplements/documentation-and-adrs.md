# Documentation and ADRs

Use this supplement when a task changes architecture, public behavior, configuration, operations, or onboarding.

- Update docs only when behavior, setup, commands, configuration, or architecture actually changes.
- Prefer small colocated documentation updates over broad doc rewrites.
- Add or update an ADR when the implementation introduces a durable architectural decision or changes an ownership boundary.
- Document new environment variables, CLI commands, service behavior, and operational recovery steps.
- Do not let docs replace tests or code-level safeguards.
- If docs are required but out of scope for the current implementation slice, call that out explicitly in the plan.