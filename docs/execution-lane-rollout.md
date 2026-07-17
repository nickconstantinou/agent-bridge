# Execution lane isolation rollout

Status: guarded deployment contract for Issue #131. This document does not authorize deployment.

## Required sequence

Use the separately installed root-owned helper documented in [GUARDED-ROLLOUT.md](GUARDED-ROLLOUT.md). It enforces the strict **preflight → stop-all → verify stopped → backup → migrate → validate → start-all → smoke** sequence. Confirm every old service process has exited before migration and do not allow old/new binary overlap. Starting one provider at a time is not safe because all surfaces share the SQLite schema.

Before stopping services, record the **legacy queue count** reported by migration diagnostics. Require an **explicit discard decision** from the operator; quarantined rows must never drain automatically. Preserve a database backup and rollback binary before schema migration.

Migration adds queue claim state and `attachments_json` with backward-compatible defaults. After start-all, verify live-surface pending lanes are claimed oldest-first and that the startup recovery log is free of repeated handler failures. Rollback must preserve the pre-migration database backup because older binaries do not understand claimed rows or queued attachment ownership.

Text queue rows are host-restart durable in SQLite. Queued attachment paths and files are process/service-restart durable on the same host only: files remain under the operating system temporary directory and may be removed by host reboot, `/tmp` cleanup, or private-temp service configuration. Do not claim host-restart durability for queued attachments until a persistent spool beside the SQLite database is implemented.

Old flat private-chat history remains quarantined under its original flat chat key. It must not be copied or assigned to an arbitrary private topic. Topic keys begin receiving new history only after the upgraded services start.

Deployment, restart, legacy-row discard, and production acceptance each require separate approval. PR merge approval is not deployment approval.

## Wider parallelism gate

Shared repository/worktree concurrency is guarded by the OS-backed canonical-worktree lock delivered for Issue #133. Same-checkout CLI runs serialize across services and databases; genuinely different checkouts remain independent.
