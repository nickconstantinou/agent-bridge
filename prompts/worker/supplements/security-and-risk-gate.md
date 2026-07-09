# Security and risk gate

Use this supplement whenever a worker prompt could lead to code changes or automated approval.

Stop and report `HUMAN_DECISION_REQUIRED` before editing when the required work involves:

- authentication or authorization behavior
- secrets, tokens, credentials, or key material
- billing, payments, or customer entitlements
- destructive data changes or deletion
- database migrations with rollback risk
- production infrastructure changes
- force-push, history rewrite, or irreversible repository actions
- broad behavior changes outside the approved work item

When safe to proceed, preserve secure defaults, validate inputs at trust boundaries, avoid logging sensitive values, and keep changes reversible.