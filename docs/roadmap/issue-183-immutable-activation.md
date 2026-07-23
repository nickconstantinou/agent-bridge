# Issue #183 — immutable activation closeout slice

This document records the non-production activation boundary implemented for
Issue #183. It does not authorize deployment or change live services,
databases, queues, or workspaces.

## State machine

```text
PRECHECK -> CONTAINED -> WAL_DRAINED -> BACKED_UP -> MIGRATED
  -> POINTER_SWITCHED -> SERVICES_STARTED -> ACCEPTED -> COMPLETE

pre-start failure -> verified database restore -> previous pointer
  -> previous release restart -> health verification -> FAILED_RESTORED

start-attempt or ambiguous failure -> stop and contain ->
  preserve new state/evidence -> STOPPED_PRESERVED / manual review
```

## Guarantees

- Release mode never switches or resets a live Git checkout.
- `current` is published by the atomic release activation helper only after
  containment, WAL checkpointing, backup, migration, and validation.
- A proven pre-start failure restores the byte-verified database cohort,
  reactivates the previous immutable release, and verifies service health.
- Any start attempt, uncertain containment, pointer ambiguity, or possible
  write acceptance remains fail-closed and requires manual review.
- SQLite WALs are drained with `wal_checkpoint(TRUNCATE)`; rollout code does
  not delete a non-empty WAL as a substitute for checkpointing.
- Queue counts and resolving-unit evidence remain in the database evidence;
  rollout does not discard, replay, or rewrite pending queue rows.

## Evidence

Each rollout artifact records containment, preflight/stopped/checkpoint,
backup, migration, validation, pointer-switch, startup, and post-start
evidence. JSON evidence receives SHA-256 sidecar manifests. Immutable release
evidence binds the target and previous commits to the rollout-helper SHA-256.

## Remaining operational gate

Production installation, deployment, service restart, live WAL/database
mutation, and Telegram acceptance verification remain separate approved
operations. They must be performed only after human review of the exact
artifact, current pointer, database inventory, rollback evidence, and service
health plan.
