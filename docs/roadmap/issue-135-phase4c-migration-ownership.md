# Issue #135 Phase 4C — Production Migration Ownership and Gating

Status: **draft policy and implementation plan. Docs only — no code, migration, rollout-tooling, service, or production change is authorized by this document.** Production deployment of the merged Phase 4A/4B work (`main` @ `8e7b8fd62d2fd32d4c7cad66c5085fb85423e1d1`, PRs #147 and #154) remains blocked until this plan is reviewed and its implementation phase merged.

## 0. Why this exists

PR #147 established `CURRENT_SCHEMA_VERSION` and a transactional migration boundary, but deliberately left production migration *ownership* undefined: `openDb()` — called identically by every ordinary service entrypoint and by `scripts/rollout-db.ts`'s `migrate` mode — auto-migrates a legacy (`user_version = 0`) database on open. That means today, an ordinary service restart against a stale-schema database would silently migrate it outside the guarded rollout helper's containment, backup, and evidence machinery. This document defines the contract that closes that gap.

## 1. Locked decisions

These are settled; the rest of this document designs around them, not toward alternatives.

1. **Ordinary production startup:**
   - **current** schema → starts normally.
   - **legacy** schema → fails closed with a "migration required" error. It does **not** auto-migrate.
   - **future** schema → fails closed before WAL mode or any write (already true as of PR #147; reaffirmed here as permanent policy, not just current code behavior).
2. **The guarded rollout helper (`scripts/rollout-agent-bridge.sh` + `scripts/rollout-db.ts`) is the sole production migration owner.** No other code path — not ordinary `openDb()`, not a service's own startup logic — may advance a production database's schema version.
3. **No live/in-place downgrade or down migrations.** There is no code path that reduces `user_version` or reverses a migration's DDL on a running database.
4. **Rollback after a committed migration means restoring the complete pre-migration database cohort and previous binary/configuration** — not a schema-level down-migration. This matches the rollout helper's existing backup/restore model exactly; it is not a new mechanism.
5. **All database-consuming services must be stopped before migration, with no restart until every database reaches and validates the exact target version.** Partial restart (some services back up on the new schema while others are still stopped) is not a supported intermediate state.
6. **Shared database paths must be canonicalised and migrated once.** Multiple units resolving to the same file (see §3) must be deduplicated before any backup or migration step; each canonical file is touched exactly once per rollout.
7. **Any migration or validation failure restores the whole cohort.** Partial success — some of the five databases migrated and validated, others not — is not an acceptable end state; either all five reach and validate the target version, or all five are restored to their pre-migration state.
8. **Interrupted rollouts remain explicitly incomplete.** A rollout that stops mid-sequence (process killed, machine rebooted, operator Ctrl-C) must not silently resume as either the old or the new release. It must require explicit operator re-invocation, and the containment/precondition checks must re-verify from scratch rather than trusting an interrupted run's partial state.

## 2. Startup behaviour matrix

Applies to `openDb()` as called from the five ordinary-startup entrypoints (`src/index.ts`, `src/index-worker.ts`, `src/index-interactive.ts`, `src/index-discord-interactive.ts`, `src/index-health.ts`).

| Schema state (`user_version`) | Current behaviour (PR #147) | Required behaviour (this policy) |
|---|---|---|
| `current` (`== CURRENT_SCHEMA_VERSION`) | Starts normally | Unchanged — starts normally |
| `legacy` (`0`) | Auto-migrates transactionally, then starts | **Fails closed** before WAL mode or any write, with an error identifying the required rollout action. Does not migrate. |
| `migratable` (`0 < user_version < CURRENT_SCHEMA_VERSION`, once multi-step migrations exist) | N/A today (only versions 0 and 1 exist) | Same as legacy — fails closed, does not migrate |
| `future` (`> CURRENT_SCHEMA_VERSION`) | Fails closed before WAL, connection closed, error thrown | Unchanged — this is already correct and is the template the legacy case is being brought in line with |
| Negative / non-integer | Fails closed before WAL (per PR #147 round-2 review fix) | Unchanged |

## 3. Rollout-time behaviour matrix

Applies to `scripts/rollout-db.ts`'s `inspect` / `migrate` / `validate` modes, invoked only from `scripts/rollout-agent-bridge.sh` after containment is proven (guarded rollout helper phase 4 in `docs/GUARDED-ROLLOUT.md`).

| Mode | Current behaviour | Required behaviour |
|---|---|---|
| `inspect` | Read-only schema/integrity/queue evidence per database; aborts if any legacy queue count is nonzero | Unchanged, plus: cross-check that the resolved database set, once canonicalised (§4), matches the expected five-role inventory exactly — extra or missing canonical paths abort before backup |
| `migrate` | Calls `openDb(path, ...)` directly per database, relying on its auto-migrate behaviour | Calls a **new, explicit migration entry point** (not the ordinary `openDb()` — see §6) that only accepts `legacy`/`migratable` input and only the rollout helper is authorized to call. Same transactional/FK-check guarantees as today. |
| `validate` | Re-inspects each database and requires `schema === "current"` | Unchanged |

## 4. Five-database-role inventory and shared-path handling

Current production topology (`systemd/agent-bridge-rollout.conf.example`), seven units resolving to five canonical databases:

| Unit(s) | Resolved `DB_PATH` / `HEALTH_DB_PATH` | Canonical database |
|---|---|---|
| `agent-bridge-antigravity.service`, `agent-bridge-claude.service`, `agent-bridge-codex.service` | `/home/content-crawler/agent-bridge/.data/bridge.sqlite` (shared — see note) | **shared** |
| `agent-bridge-discord-interactive.service` | `/home/content-crawler/agent-bridge/.data/discord-interactive.sqlite` | **discord** |
| `agent-bridge-health.service` | `/home/content-crawler/agent-bridge/.data-health/health.sqlite` | **health** |
| `agent-bridge-interactive.service` | `/home/content-crawler/runtime/agent-bridge/interactive/bridge.sqlite` | **interactive** |
| `agent-bridge-worker-bot.service` | `/home/content-crawler/runtime/agent-bridge/worker/bridge.sqlite` | **worker** |

**Note on the shared role:** the per-CLI-kind `.env.<kind>.example` files (`.env.antigravity.example`, `.env.claude.example`, `.env.codex.example`) show *different* default `DB_PATH` values per kind (`.data-antigravity/`, `.data-claude/`, `.data-codex/`) — these are development defaults. The production `rollout.conf` example coalesces all three onto one canonical `bridge.sqlite`. This divergence between documented per-kind defaults and actual shared production configuration is exactly the hazard locked decision 6 exists to guard against: canonicalisation must be done by resolving each unit's *actual effective* `DB_PATH` (already implemented — see `docs/GUARDED-ROLLOUT.md` §"Resolve each selected unit's effective `DB_PATH`") and deduplicating by resolved real path (`realpath`, not string equality) before any backup or migration step touches a file twice.

**Requirement:** `rollout-db.ts inspect` evidence must record, per canonical database, the full list of units that resolve to it, so a review of rollout evidence can confirm the five-role → seven-unit mapping matches expectation and no unit is silently pointing at an unexpected file.

## 5. Ownership boundaries

| Concern | Owner | Not owned by |
|---|---|---|
| Schema version validation on ordinary startup | `src/db.ts` `openDb()` (fail-closed gate, §2) | Individual service entrypoints — they must not duplicate version-checking logic |
| Schema migration execution | `scripts/rollout-db.ts` `migrate` mode, invoked only by `scripts/rollout-agent-bridge.sh` | `openDb()` under ordinary startup; any service; any ad hoc script |
| Containment (stop, prove dead) | `scripts/rollout-agent-bridge.sh` phase 4 (existing, unchanged) | — |
| Backup | `scripts/rollout-agent-bridge.sh` phase 6 (existing, unchanged) | — |
| Restore | `scripts/rollout-restore.py`, invoked by `rollout-agent-bridge.sh` (existing, unchanged) | — |
| Legacy DDL / historical repair logic | `src/db/legacyBaselineMigration.ts` (migration 1, unchanged from PR #147) | — |
| Advisor / conversation-turn persistence | `AdvisorRepository` / `ConversationRepository` (PR #154, unchanged) | — |
| `pending_messages` queue persistence | `BridgeDb` + `LockRepository` (final boundary, Issue #135 decision comment 2026-07-18) | — |
| Exact-version rollout gate | `rollout-db.ts` `validate` mode (existing `requireCurrent` check, unchanged) | — |
| Deployment approval | Explicit separate human authorization, every time (existing project convention throughout this issue's history) | Any automated process |

## 6. Proposed rollout-helper changes

Minimal, additive — no removal of existing containment/backup/evidence machinery.

1. **`src/db.ts`: split the migration entry point.**
   `openDb()` (used by all five ordinary entrypoints) changes its version gate from "reject only `> CURRENT_SCHEMA_VERSION`" to "reject anything that is not exactly `CURRENT_SCHEMA_VERSION`" — i.e. legacy now fails closed too, with a distinct, actionable error (`MigrationRequiredError`, separate from `UnsupportedSchemaVersionError`, so operators and logs can tell "you're behind" from "you're ahead/corrupt" at a glance). A new, separate export — e.g. `openDbForMigration()` — retains today's `openDb()` auto-migrate behavior and is the *only* thing `rollout-db.ts migrate` mode is allowed to call. Both share the same `applyMigrations()`/`legacyBaselineMigration.ts` internals; only the entry point and version-gate strictness differ. Verified by grep across `test/*.ts`: only `test/dbSchema.test.ts` exercises legacy-fixture migration through `openDb()`, and every one of those cases is exactly the migration-path testing that moves to `openDbForMigration()` under 4C.2 — no other test relies on ordinary `openDb()` auto-migrating a legacy database as a success path, so this is a pure narrowing, not a behavior removal any other caller depends on. Re-verify this grep at 4C.2 implementation time in case new tests have landed since this document was written.

2. **`rollout-db.ts`: switch `migrate` mode to `openDbForMigration()`.**

3. **`rollout-db.ts inspect`: add per-database "resolving units" evidence field** (§4), sourced from the same unit/env resolution `rollout-agent-bridge.sh` already performs — pass the resolved unit→path mapping into `rollout-db.ts` as evidence input rather than re-deriving it.

4. **`rollout-agent-bridge.sh`: add an explicit interrupted-rollout guard (locked decision 8).** Before acquiring the exclusive OS rollout lock, check for a stale in-progress marker from a prior run (the helper already writes timestamped evidence per phase — add a lightweight `IN_PROGRESS` sentinel written at lock acquisition and removed only on a clean terminal outcome — success or a fully-evidenced, fully-restored failure). If a stale sentinel is found, abort immediately with an instruction to review the prior run's evidence before manually clearing it. This is deliberately a hard stop, not an auto-resume — matches the "must not silently restart either release" requirement.

5. **No change to:** containment proof, backup/restore mechanics, `--expected-commit` exact-SHA requirement, sudoers/config model, or the "legacy queue discard is unsupported" rule.

## 7. Failure and interruption semantics

| Failure point | Current helper behavior (unchanged) | This policy's addition |
|---|---|---|
| Precondition/containment failure (before backup) | Aborts, no rollback needed (nothing touched yet) | None needed |
| Backup failure | Aborts before migration; databases untouched | None needed |
| Migration failure (mid-`migrate` across the five databases) | Not explicitly specified today for the *partial* case | **Explicit requirement (locked decision 7): if any of the five fails to reach/validate `current`, the whole cohort is restored from the just-taken backups — not just the failed one.** Implement as: run `migrate` for all five, collect failures, and if any failed, run restore for all five regardless of individual success, before returning a nonzero exit. |
| Post-migration, pre-start failure | Databases preserved, evidence retained, operator review required (existing) | Unchanged — this already matches "no silent rollback after migration commits" |
| Post-start failure (service won't come up on new schema) | Services stopped and reverified, migrated databases and evidence preserved, operator review required (existing) | Unchanged |
| Process killed / machine rebooted mid-rollout | Not explicitly guarded today | **New: interrupted-rollout sentinel (§6.4) forces a hard stop and manual review on the next invocation — never an automatic resume in either direction.** |

## 8. Rollout state machine

```
IDLE
  │  (operator invokes with --expected-commit)
  ▼
LOCK_ACQUIRED ──(sentinel written)──▶ PRECONDITIONS_CHECKED
  │ fail: release lock, remove sentinel, exit nonzero
  ▼
CONTAINMENT_PROVEN
  │ fail: release lock, remove sentinel, exit nonzero — nothing touched
  ▼
BACKED_UP (all five)
  │ fail: release lock, remove sentinel, exit nonzero — databases untouched
  ▼
MIGRATING (all five, via openDbForMigration())
  │ any failure ──▶ RESTORING (all five) ──▶ FAILED_RESTORED (sentinel removed, exit nonzero)
  ▼ all five succeed
VALIDATED (all five == CURRENT_SCHEMA_VERSION, requireCurrent check passes)
  │ fail ──▶ RESTORING (all five) ──▶ FAILED_RESTORED
  ▼
STARTING (all seven units)
  │ fail ──▶ STOPPED_PRESERVED (sentinel remains removed only after operator-confirmed resolution; migrated DBs + evidence preserved, no auto-rollback)
  ▼
VERIFIED_ACTIVE (sentinel removed) ──▶ DONE
```

Interrupted at any state before `DONE`: next invocation finds the sentinel, hard-stops, requires manual review (§6.4) — it does not attempt to infer which state was reached and resume.

## 9. Rollback state machine

Rollback is **restore, not down-migration** (locked decision 4), and only ever operates on the whole cohort (locked decision 7).

```
FAILED_RESTORED / STOPPED_PRESERVED (operator decides rollback is required)
  │
  ▼
RESTORE_INVOKED (rollout-restore.py, existing mechanics — O_DIRECTORY|O_NOFOLLOW, atomic rename, mode/ownership preserved)
  │ restore fails ──▶ CONTAINMENT_INCOMPLETE-equivalent: operator must intervene manually, evidence points at exact byte-level backup state
  ▼
RESTORED (all five databases bitwise-identical to pre-migration backups, verified by SHA-256 against the recorded manifest)
  │
  ▼
PREVIOUS_BINARY_DEPLOYED (separate, manual: checkout/deploy the previous commit — not part of the DB rollback mechanism itself)
  │
  ▼
SERVICES_RESTARTED (previous binary + restored databases — a schema/binary pairing that was already proven to work)
```

There is no state in this machine that represents "new binary + old schema" or "old binary + new schema" as a supported combination — both are excluded by locked decisions 3 and 5.

## 10. Phased implementation plan

| Phase | Scope | Depends on |
|---|---|---|
| 4C.1 | This document, reviewed and merged (docs only) | — |
| 4C.2 | `openDb()`/`openDbForMigration()` split in `src/db.ts`; `MigrationRequiredError`; full-repo grep confirming no caller relies on ordinary-open auto-migration of a legacy DB; characterization tests locking current `future`/`current` behavior unchanged, new tests for the legacy-fails-closed path | 4C.1 |
| 4C.3 | `rollout-db.ts` switched to `openDbForMigration()`; per-database resolving-units evidence field; whole-cohort restore-on-partial-migration-failure | 4C.2 |
| 4C.4 | `rollout-agent-bridge.sh` interrupted-rollout sentinel | 4C.3 (can proceed in parallel with 4C.3 if reviewed as a separate PR) |
| 4C.5 | Full test/UAT matrix (§11) executed against a non-production fixture environment | 4C.2–4C.4 merged |
| 4C.6 | This issue's Phase 4C acceptance criteria reviewed and checked off; Issue #135 updated | 4C.5 |
| 4C.7 | Separately authorized production deployment (§12 runbook) | 4C.6, explicit human approval |

Each of 4C.2–4C.4 is its own draft PR through the same review discipline as PRs #147/#154 (red-green-refactor, full parallel+serial suite, arch-lint, exact-head CI, no merge without explicit approval).

## 11. Test and UAT matrix

| Case | Level | Proves |
|---|---|---|
| Ordinary `openDb()` on a `current`-version DB | Unit (characterization, must stay green) | No regression from the split |
| Ordinary `openDb()` on a `future`-version DB | Unit (characterization, must stay green) | Existing fail-closed-before-WAL behavior unchanged |
| Ordinary `openDb()` on a `legacy`-version (`user_version = 0`) DB | Unit (new, must be red before 4C.2, green after) | New fail-closed behavior; no WAL/write occurs (mirrors the PR #147 future-version test's sidecar-file assertions) |
| `openDbForMigration()` on a `legacy` DB | Unit (moved from existing `openDb()` tests) | Migration still works exactly as PR #147 proved, just under the new entry point |
| `rollout-db.ts inspect` on the real five-role shape, with shared antigravity/claude/codex path | Integration (new) | Canonicalisation correctly collapses three units to one database, no double-processing |
| `rollout-db.ts migrate` with one of five databases deliberately made unmigratable (e.g. injected FK violation, per PR #147's `foreign_key_check` gate) | Integration (new) | Whole-cohort restore triggers, not just the failed database |
| `rollout-agent-bridge.sh` killed mid-`MIGRATING` (simulated) | UAT, non-production fixture environment | Sentinel present on next invocation; hard stop; no auto-resume in either direction |
| `rollout-agent-bridge.sh` full run against a five-database fixture cohort seeded with realistic legacy shapes (reuse PR #147's fixed pre-versioned SQL fixtures) | UAT, non-production fixture environment | End-to-end containment → backup → migrate → validate → start → verify, matching `docs/GUARDED-ROLLOUT.md`'s documented sequence exactly |
| Full rollback drill: fixture cohort, forced mid-migration failure, restore, verify byte-identical to pre-migration backup via SHA-256 | UAT, non-production fixture environment | Locked decision 4 and 7 hold under a real (if fixture-scale) failure |
| Existing rollout-helper test suite (`test/rolloutHelper.test.ts`, 39 tests) | Regression | No existing containment/backup/evidence guarantee regresses |

## 12. Production deployment runbook (for 4C.7, not this PR)

Reproduced here as the target end-state the phased plan is building toward — **not authorized for execution by this document.**

1. Confirm 4C.2–4C.6 merged to `main`; record the exact `main` SHA to be deployed.
2. Inventory the live instance: confirm all seven units and five canonical database paths match §4 exactly (no drift since this document was written).
3. Take and independently verify rollback backups (the guarded rollout helper does this as part of its own sequence, but a pre-flight manual backup + off-host copy is a reasonable additional safety margin given this is the first real-world exercise of the new gating model).
4. Dry-run `rollout-db.ts inspect` against the live five databases (read-only) to confirm current schema state, zero legacy queue count, and expected resolving-units mapping before touching anything.
5. Obtain explicit, separate human authorization for the actual rollout (per this project's standing rule — no deployment proceeds on implicit approval).
6. Invoke `sudo -n /usr/local/sbin/rollout-agent-bridge --expected-commit <exact 40-char SHA>`.
7. On success: verify every service active, `rollout-db.ts validate` reports `current` for all five, queues intact (counts match pre-rollout inspect), logs show no migration/credential/process-lifecycle errors.
8. On any failure: do not attempt manual remediation — follow the evidence path recorded in `log_dir/latest`, and if rollback is warranted, use the state machine in §9. Report the exact failure per this thread's standing reporting convention.

---

Refs #135. This document supersedes no prior decision recorded in Issue #135; it implements the Phase 4C section already present there.
