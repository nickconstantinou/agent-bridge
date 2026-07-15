# Execution lane isolation rollout

Status: guarded deployment contract for Issue #131. This document does not authorize deployment.

## Required sequence

Use a strict **stop-all → migrate → start-all** sequence. Confirm every old service process has exited before migration and do not allow old/new binary overlap. Starting one provider at a time is not safe because all surfaces share the SQLite schema.

Before stopping services, record the **legacy queue count** reported by migration diagnostics. Require an **explicit discard decision** from the operator; quarantined rows must never drain automatically. Preserve a database backup and rollback binary before schema migration.

Old flat private-chat history remains quarantined under its original flat chat key. It must not be copied or assigned to an arbitrary private topic. Topic keys begin receiving new history only after the upgraded services start.

Deployment, restart, legacy-row discard, and production acceptance each require separate approval. PR merge approval is not deployment approval.

## Wider parallelism gate

Shared repository/worktree concurrency is a separate high-priority issue. Record and resolve workspace ownership, git mutation, and concurrent tool execution risks before enabling wider parallel surface execution; it is intentionally outside PR #131.
