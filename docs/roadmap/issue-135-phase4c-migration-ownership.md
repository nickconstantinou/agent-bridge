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
9. **Fresh/missing-database bootstrap is a distinct, explicitly owned path — not a variant of "legacy."** A database that doesn't exist yet (first install, or a genuinely new role added later) is not "behind schema," it's absent. Bootstrap creation is the responsibility of the guarded rollout helper's install/first-run path (§6.5), never an implicit side effect of an ordinary `openDb()` call.
10. **`openDb()` itself is not the strict gate.** It stays the general-purpose, backward-compatible opener — dozens of existing tests (`test/db.test.ts` alone has 15+ call sites) rely on it creating a brand-new file-backed database on a missing path as everyday setup, not as legacy-fixture migration testing specifically. Redefining `openDb()` to require an existing file would be a breaking public-API change with no compatibility path, not a narrowing. The strict fail-closed contract in §2 belongs to a **new, additive** entry point used only by the five ordinary-startup service entrypoints (§6.1) — `openDb()`'s existing behavior and every test that depends on it are unchanged.

## 2. Startup behaviour matrix

Applies to a **new, additive** strict opener — provisionally `openProductionDb()`, exported alongside `openDb()` from `src/db.ts` — used only by the five ordinary-startup entrypoints (`src/index.ts`, `src/index-worker.ts`, `src/index-interactive.ts`, `src/index-discord-interactive.ts`, `src/index-health.ts`). **`openDb()` itself does not change** (locked decision 10) — it keeps its current create-if-missing, auto-migrate behavior exactly as today, because dozens of existing tests depend on that as ordinary setup, not as a legacy-migration-specific path. `openProductionDb()` shares `openDb()`'s internal WAL/FK-pragma/`BridgeDb`-construction tail (extracted into a private helper both call, to avoid duplicating that logic) but replaces the file-open mode and version gate:

| Schema state (`user_version`) | `openDb()` (unchanged) | `openProductionDb()` (new) |
|---|---|---|
| `current` (`== CURRENT_SCHEMA_VERSION`) | Starts normally | Starts normally |
| `legacy` (`0`, file exists) | Auto-migrates transactionally, then starts | **Fails closed** before WAL mode or any write, with `MigrationRequiredError` identifying the required rollout action. Does not migrate. |
| `migratable` (`0 < user_version < CURRENT_SCHEMA_VERSION`, once multi-step migrations exist) | Auto-migrates | Fails closed with `MigrationRequiredError`, same as legacy |
| `future` (`> CURRENT_SCHEMA_VERSION`) | Fails closed before WAL, connection closed, `UnsupportedSchemaVersionError` | Same — this is already correct in `openDb()` today and `openProductionDb()` inherits it unchanged |
| Negative / non-integer | Fails closed before WAL (per PR #147 round-2 review fix) | Same |
| **Missing file** | Creates the file (`new Database(dbPath)`'s default mode), applies migration 1's full DDL, ends at `CURRENT_SCHEMA_VERSION` — this is already correct and already tested (`dbSchema.test.ts`'s "keeps a fresh database at the current version" case) and is the mechanism bootstrap reuses (§3) | `{ fileMustExist: true }` — fails closed with a distinct `DatabaseMissingError`. No directory or file is created by production service startup, ever. |

## 3. Rollout-time behaviour matrix

Applies to `scripts/rollout-db.ts`'s `inspect` / `migrate` / `validate` modes, invoked only from `scripts/rollout-agent-bridge.sh` after containment is proven (guarded rollout helper phase 4 in `docs/GUARDED-ROLLOUT.md`).

| Mode | Current behaviour | Required behaviour |
|---|---|---|
| `inspect` | Read-only schema/integrity/queue evidence per database; `fileMustExist: true`; aborts if any legacy queue count is nonzero | Unchanged, plus: cross-check that the resolved database set, once canonicalised (§4), matches the expected five-role inventory exactly — extra or missing canonical paths abort before backup |
| `migrate` | Calls `openDb(path, ...)` directly per database in a plain loop — a mid-loop failure propagates immediately and does not attempt the remaining databases (already fail-fast; verified by reading the loop, no per-database try/catch) | **Unchanged — keeps calling `openDb()`.** This is exactly the auto-migrating behavior the guarded rollout helper is supposed to own; nothing here was ever the problem. Same fail-fast, no-partial-continuation, transactional/FK-check guarantees as today. |
| `validate` | Re-inspects each database and requires `schema === "current"` | Unchanged |
| **First-run bootstrap** (new mode) | Not supported — `rollout-agent-bridge.sh` requires every discovered database to already exist (`[[ -f "$discovered" ]] || die ...`) before acquiring the lock, and `rollout-db.ts inspect`/`migrate`/`validate` all open with `fileMustExist: true` | **New, explicitly separate `bootstrap` mode.** Reuses `openDb()`'s existing missing-file path unchanged — it already creates the file and runs it through migration 1's real DDL (`applyLegacyCompatibleBaseline`/`applyMigrations`), the same registered plan every other database goes through, so there is no duplicated or shortcut schema definition. What's new is entirely at the rollout-helper level, not the database layer: a root-owned, separately-invoked route (not folded into the ordinary `--expected-commit` migrate flow) with its own allowlist of expected new-role paths, parent-directory/ownership validation matching the existing backup-directory discipline, atomic creation (write to a temp path, then atomic rename into place, mirroring `rollout-restore.py`'s existing descriptor-relative approach), and cleanup of the partial file if `openDb()`'s migration fails partway. Never invoked implicitly by `inspect`/`migrate`/`validate`, and never bundled into the same invocation as a migration of *existing* databases — no pre-migration backup exists for a database that didn't exist, so it cannot participate in the whole-cohort restore guarantee (locked decision 7) the same way. Requires explicit operator confirmation that the missing file is expected (new role), not a symptom of misconfiguration or accidental deletion. |

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
| Schema version validation on ordinary (production) startup | `openProductionDb()` (new, §6.1) — the five service entrypoints import only this, never `openDb()` directly | Individual service entrypoints — they must not duplicate version-checking logic |
| `openDb` import/call anywhere under production `src/` | **Nothing** — prohibited by default, deny-by-default arch-lint rule (§6.6), not a five-file allowlist | Every `src/` file except `src/db.ts` itself, entrypoint or not — including any future module, not just the five known today |
| General-purpose database open (tests, dev, and the rollout helper's own migration) | `src/db.ts` `openDb()` — unchanged (locked decision 10); freely usable from `test/*.ts` and `scripts/rollout-db.ts`, both outside the `src/` rule above | — |
| Schema migration execution | `scripts/rollout-db.ts` `migrate` mode, calling the unchanged `openDb()`, invoked only by `scripts/rollout-agent-bridge.sh` | Ordinary service entrypoints, which use `openProductionDb()` and never migrate; every other `src/` module (enforced by the deny-by-default rule above) |
| First-run database bootstrap | `scripts/rollout-db.ts` `bootstrap` mode (new — §2, §3), reusing `openDb()`'s existing missing-file path, never invoked implicitly | `openProductionDb()` under ordinary startup (must `fileMustExist`, never create); `migrate`/`inspect`/`validate` modes |
| Containment (stop, prove dead) | `scripts/rollout-agent-bridge.sh` phase 4 (existing, unchanged) | — |
| Backup | `scripts/rollout-agent-bridge.sh` phase 6 (existing, unchanged) | — |
| Restore | `scripts/rollout-restore.py`, invoked by `rollout-agent-bridge.sh` (existing, unchanged) | — |
| Legacy DDL / historical repair logic | `src/db/legacyBaselineMigration.ts` (migration 1, unchanged from PR #147) | — |
| Advisor / conversation-turn persistence | `AdvisorRepository` / `ConversationRepository` (PR #154, unchanged) | — |
| `pending_messages` queue persistence | `BridgeDb` + `LockRepository` (final boundary, Issue #135 decision comment 2026-07-18) | — |
| Exact-version rollout gate | `rollout-db.ts` `validate` mode (existing `requireCurrent` check, unchanged) | — |
| Deployment approval | Explicit separate human authorization, every time (existing project convention throughout this issue's history) | Any automated process |

## 6. Proposed rollout-helper changes

Minimal, additive — no removal of existing containment/backup/evidence machinery, and **`openDb()` itself is untouched** (locked decision 10).

1. **`src/db.ts`: add `openProductionDb()`, leave `openDb()` alone.**
   `openDb()` keeps its exact current signature and behavior — create-if-missing, auto-migrate on legacy, everything the ~15+ existing `test/db.test.ts` call sites (and more elsewhere) already depend on. A new, additive export `openProductionDb()` shares `openDb()`'s internal WAL-pragma/FK-pragma/non-schema-maintenance/`BridgeDb`-construction tail — extracted into a private helper both functions call, so that shared logic isn't duplicated — but opens with better-sqlite3's `{ fileMustExist: true }` (missing file → `DatabaseMissingError`, no directory or file created) and a strict version gate: anything that is not exactly `CURRENT_SCHEMA_VERSION` fails closed before WAL mode or any write, with `MigrationRequiredError` for legacy/migratable (distinct from `UnsupportedSchemaVersionError` for future/negative/non-integer, so operators and logs can tell "you're behind" from "you're ahead/corrupt" at a glance).

   This is purely additive: no existing `openDb()` caller changes, no test needs to move. The five ordinary-startup entrypoints switch their one `openDb(...)` call each to `openProductionDb(...)`.

2. **`rollout-db.ts`: no change to `migrate` mode.** It keeps calling `openDb()` exactly as today — that auto-migrating behavior was never the problem; the problem was ordinary services also being able to reach it. No change to its existing fail-fast behavior either (confirmed by reading the current implementation: a plain loop over databases with no per-database try/catch, so a failure on database N already stops before attempting N+1).

3. **`rollout-db.ts inspect`: add per-database "resolving units" evidence field** (§4), sourced from the same unit/env resolution `rollout-agent-bridge.sh` already performs — pass the resolved unit→path mapping into `rollout-db.ts` as evidence input rather than re-deriving it.

4. **`rollout-agent-bridge.sh`: add an explicit interrupted-rollout guard (locked decision 8), with one unambiguous sentinel-lifecycle contract.**

   Lock-then-sentinel ordering (avoids the check-then-act race in an earlier draft: a second invocation observing no sentinel, then acquiring the lock only after a third invocation had already failed and left one behind), all under the *existing* `flock --exclusive --nonblock` at the point already in the script (line ~192, before any precondition check runs):
   1. Acquire the exclusive `flock` (unchanged — the sole serialization point).
   2. Immediately after, inspect the sentinel path under that same lock. If present, abort with an instruction to review the prior run's evidence before manually clearing it.
   3. Atomically create the new sentinel (`O_CREAT|O_EXCL`) before any precondition check proceeds.

   **Removal contract — one rule, not exit-code-dependent** (the script's overall exit status stays nonzero on every failure path, including a cleanly auto-restored one, so exit code alone can't signal "safe to retry"; a dedicated flag is required). The contract is gated on *containment*, not merely on which phase failed — a precondition failure that occurs before any stop attempt is unambiguous, but a failure *at or after* the primary stop attempt is only safe to treat as "nothing touched" if containment was independently re-proven, exactly mirroring `on_exit`'s own real logic (`stop_and_verify_all_services` is re-run inside the trap and gates whether `restore_backups` is even attempted):
   - **Remove** the sentinel when, and only when, the run reaches one of these *verified-safe* states:
     (a) `DONE` — full success;
     (b) failure strictly **before** `stop_attempted` is set (pure precondition failure — nothing was ever touched, containment was never even attempted, so there is nothing to re-verify);
     (c) failure **at or after** the primary stop attempt, where `on_exit`'s own re-run of `stop_and_verify_all_services` succeeds — i.e. containment is independently proven even if the original stop command itself returned nonzero (matches `docs/GUARDED-ROLLOUT.md`'s existing rule that a nonzero stop result is accepted as evidence, not a failure, once containment is proven) — and no backup/migration write has happened yet ($`manifest` empty);
     (d) **verified full restoration** — `restore_backups` returns success (not merely attempted) *and* every restored database's SHA-256 matches the backup manifest.
     Introduce an explicit `sentinel_removable` flag set only in these four cases — never inferred from `$?`.
   - **Retain** the sentinel in every other case: process killed or machine rebooted mid-rollout (nothing runs to remove it); containment cannot be re-proven during the failure trap ("rollback skipped: stopped state could not be proven" — genuinely unknown whether services are actually down); `restore_backups` itself fails or returns partial/unverified success (§6.4 introduces a distinct state for this — see §9); and post-start failure (`STOPPED_PRESERVED` — services already running against the new schema, so an automatic DB rollback could race live writes; this always requires operator judgment, never an automatic retry).

5. **New `bootstrap` mode for genuinely missing databases (§2, §3).** Explicitly separate invocation from ordinary migration; never runs implicitly; reuses `openDb()`'s existing, already-tested missing-file→full-migration-plan path at the database layer, with new root-owned allowlist/ownership/atomic-creation/cleanup-on-failure machinery at the rollout-helper level (§3).

6. **Enforce sole migration ownership as a deny-by-default rule across production `src/`, not a five-file allowlist.** An earlier draft of this section only checked the five service entrypoints for an `openDb` import — but locked decision 2 says *no other code path* may advance a production schema version, and a rule that only inspects five specific files leaves every other `src/` module free to import `openDb()` directly, migrate a database, and never trip the check. A comment or a narrow allowlist is not a boundary; Phase 4B already established the precedent (`scripts/sqlOwnershipLint.mjs`, PRs #147/#154) that this codebase backs ownership claims with enforcement scoped correctly the first time. Concretely: an arch-lint rule that **prohibits any `openDb` import/call anywhere under `src/`**, with exact, named exceptions rather than a broad carve-out:
   - `src/db.ts` itself (where `openDb()` is defined and `openProductionDb()`'s shared internals live) — the only production file allowed to reference `openDb` by definition.
   - No other `src/` file, entrypoint or otherwise, is exempted.

   `scripts/rollout-db.ts` and every `test/*.ts` file are outside `src/` and outside this rule's scope entirely — they keep using `openDb()` freely, as today. Regression coverage: (i) the five entrypoints importing `openProductionDb` pass; (ii) a fixture entrypoint importing `openDb` directly fails, as before; (iii) **new** — a fixture *non-entrypoint* `src/` module (e.g. a hypothetical new repository or handler file) importing `openDb` directly also fails, proving the rule isn't scoped to just the five known files.

7. **No change to:** containment proof, backup/restore mechanics, `--expected-commit` exact-SHA requirement, sudoers/config model, or the "legacy queue discard is unsupported" rule.

## 7. Failure and interruption semantics

`sentinel_removable` is the new explicit flag from §6.4 — set only in the four verified-safe cases below, never inferred from the script's overall exit code (which stays nonzero on every failure path, including a cleanly auto-restored one). Critically, **removability is gated on containment, not merely on which phase failed**: a failure strictly before any stop attempt is unambiguous, but a failure at or after the primary stop attempt is only safe to treat as "nothing touched" if `on_exit`'s own re-run of `stop_and_verify_all_services` independently re-proves containment — exactly mirroring the script's real logic, where `restore_backups` is only even attempted `if (( containment_verified == 1 ))`.

| Failure point | Current helper behavior | This policy | `sentinel_removable`? |
|---|---|---|---|
| Precondition failure, strictly before `stop_attempted` is set | Aborts, no rollback needed (nothing was ever touched, containment was never even attempted) | Unchanged | **Yes** — unambiguous, nothing to re-verify |
| Failure at/after the primary stop attempt, but `on_exit`'s re-verification of containment **succeeds** (services proven stopped, even if the original stop command itself returned nonzero — `docs/GUARDED-ROLLOUT.md` already accepts that as valid evidence) and no backup exists yet | New row (an earlier draft treated all containment/backup failures identically) | Services are stopped, no DB write has occurred (`manifest` empty, so `restore_backups` isn't even invoked) — this is a safe, known state | **Yes** |
| Failure at/after the primary stop attempt, where `on_exit`'s re-verification **fails** ("rollback skipped: stopped state could not be proven") | Existing | Unchanged | **No** — state is genuinely uncertain; could be mid-stop |
| Backup-phase failure, containment already proven | Aborts before migration; databases untouched | Same containment-gated logic as above applies — if containment was proven on the way into this phase, retry is safe | **Yes**, contingent on the same re-verification as above |
| Migration or validation failure (mid-`migrate`/`validate` across the five databases) | **Already whole-cohort restore, verified by reading the script, not assumed:** `start_attempted` is set to `1` only after both `migrate` and `validate` complete. The `on_exit` trap fires on any nonzero exit and, when `start_attempted == 0`, `containment_verified == 1`, and a backup manifest exists, calls `restore_backups` for the *entire* manifest. `rollout-db.ts migrate`'s own plain-loop fail-fast means a mid-cohort failure stops there and lets this existing trap handle the whole-cohort restore. | **No new restore implementation required — an earlier draft of this section incorrectly described this as unhandled/to-be-built.** What's needed: a UAT case (§11) proving it under a real induced failure. `restore_backups` returning success is necessary but **not sufficient** on its own — see the new `RESTORE_INCOMPLETE` state in §9 for what happens when it fails or can't be verified. | **Yes, but only if `restore_backups` succeeds AND post-restore SHA-256 verification passes for every database** — otherwise **No**, and the run lands in `RESTORE_INCOMPLETE` (§9), not `FAILED_RESTORED` |
| Post-migration, post-validation, pre-start failure | Same trap: `start_attempted` is still `0` at this point, so this is *also* already whole-cohort restore, not "preserved" as an earlier draft stated. | Corrected description only — no behavior change. | Same as the row above |
| Post-start failure (service won't come up on new schema) | `start_attempted == 1` by this point, so the trap does *not* restore — migrated databases, evidence, and the failed service state are preserved for operator review (existing, and correctly distinct from the pre-start cases above: once a service has started against the new schema, an automatic DB rollback could race with in-flight writes, so this one genuinely does require manual judgment). | Unchanged | **No** — always requires operator review, never an automatic retry |
| Process killed / machine rebooted mid-rollout | Not explicitly guarded today | **New: interrupted-rollout sentinel (§6.4) forces a hard stop and manual review on the next invocation — never an automatic resume in either direction.** | **No** — nothing runs to set the flag |

## 8. Rollout state machine

```
IDLE
  │  (operator invokes with --expected-commit)
  ▼
LOCK_ACQUIRED (flock --exclusive, existing)
  │  sentinel checked HERE, under the lock — not before acquiring it (avoids the
  │  check-then-act race: a second invocation can't observe "no sentinel" and
  │  then acquire the lock after a third invocation has already failed)
  │  existing sentinel found ──▶ ABORT (exit nonzero, lock released, sentinel left in place, operator review required)
  ▼
SENTINEL_CREATED (O_CREAT|O_EXCL, atomic, still under the lock) ──▶ PRECONDITIONS_CHECKED
  │ fail (stop_attempted still 0): release lock, sentinel_removable=true ──▶ sentinel removed, exit nonzero
  ▼
STOPPING (stop_attempted=1 set here — from this point on, removability depends on re-proven containment, not just "which phase")
  │ primary stop fails ──▶ on_exit re-runs stop_and_verify_all_services:
  │     succeeds (containment re-proven) ──▶ sentinel_removable=true ──▶ sentinel removed, exit nonzero
  │     fails ("stopped state could not be proven") ──▶ sentinel_removable=false ──▶ sentinel remains, exit nonzero
  ▼ (primary stop succeeds)
CONTAINMENT_PROVEN
  ▼
BACKED_UP (all five)
  │ fail: same containment-gated split as STOPPING above (containment was already proven to reach here,
  │   so this normally resolves to sentinel_removable=true, but on_exit always re-verifies rather than assuming)
  ▼
MIGRATING (all five, via openDb(); §6.2 — unchanged from today; plain fail-fast loop, no partial continuation)
  │ any failure ──▶ RESTORING (all five, existing on_exit trap — start_attempted still 0, containment re-verified)
  │     restore succeeds AND verified (SHA-256 match, every database) ──▶ sentinel_removable=true ──▶ FAILED_RESTORED (sentinel removed, exit nonzero)
  │     restore fails, partial, or unverified ──▶ sentinel_removable=false ──▶ RESTORE_INCOMPLETE (sentinel remains, exit nonzero, manual restoration required — see §9; NOT the same state as FAILED_RESTORED)
  ▼ all five succeed
VALIDATED (all five == CURRENT_SCHEMA_VERSION, requireCurrent check passes)
  │ fail ──▶ RESTORING (all five, same trap, same succeeds/fails split as above)
  ▼
STARTING (all seven units; start_attempted set to 1 here — trap no longer restores past this point)
  │ fail ──▶ STOPPED_PRESERVED (sentinel_removable=false always — sentinel remains present; migrated DBs + evidence preserved, no auto-rollback, operator review required)
  ▼
VERIFIED_ACTIVE ──▶ DONE (sentinel_removable=true; sentinel removed)
```

Interrupted at any state before a `sentinel_removable=true` outcome: the sentinel was created immediately after lock acquisition and is only removed on one of the four verified-safe outcomes (§6.4, §7). The next invocation acquires the lock, finds the sentinel under that same lock (no race), hard-stops, and requires manual review — it does not attempt to infer which state was reached and resume.

## 9. Rollback state machine

Rollback is **restore, not down-migration** (locked decision 4), and only ever operates on the whole cohort (locked decision 7). Three states are distinguished — `FAILED_RESTORED`, `RESTORE_INCOMPLETE`, and `STOPPED_PRESERVED` — because they represent three materially different combinations of database schema state and code state, not one shared `RESTORE_INVOKED` step.

**Code state throughout every path below:** `git_check` requires the working tree to already be checked out at `expected_commit` (the new, target commit) for the *entire* duration of a rollout invocation — this is verified repeatedly, before stop and again after stop. So at the moment any of these three states is reached, **the working tree is still the new commit**; nothing in `rollout-agent-bridge.sh` itself ever reverts code. That is exactly why locked decisions 3 and 5 matter here: new code + old (restored) schema is not a supported pairing, so the new code must never be started against a restored database, and reverting to the previous commit is always a separate, explicit, manual step before any restart.

```
FAILED_RESTORED (automatic on_exit trap restored the cohort AND verified it — §7; sentinel_removable=true, sentinel
  removed. State: services stopped, database restored to the OLD schema, code still checked out at the NEW commit
  — not started.)
  │
  ▼
VERIFY_RESTORED_COHORT (operator re-confirms: all five databases' SHA-256 match the pre-migration backup manifest —
  the automatic restore already checked this per-database during restore_backups; this is an operator-visible
  re-confirmation before deciding next steps, not a new mechanism)
  │
  ├─▶ retry: fix the root cause of the migration/validation failure, re-invoke with a corrected commit (services were
  │    never started against the new schema, so this is a fresh rollout attempt, not a partial resume)
  │
  └─▶ abandon: PREVIOUS_CODE_CHECKED_OUT (revert the working tree to the previous commit — separate, manual, outside
       this script; required before restart, since old schema + new code is not a supported pairing) ──▶
       SERVICES_RESTARTED (previous code + already-restored previous-schema database — a pairing that was already
       proven to work; services were stopped, not started, throughout, so this is a normal start, not a rollback of
       a running system)

RESTORE_INCOMPLETE (new state — the on_exit trap's restore_backups call itself failed, or succeeded but the
  post-restore SHA-256 verification did not match for every database; sentinel_removable=false, sentinel retained.
  State: unknown/mixed — some databases may be restored, some may still be on the failed-migration schema, some may
  be in an unverified intermediate state; services stopped; code still checked out at the NEW commit — not started.
  This is deliberately NOT the same state as FAILED_RESTORED — it must not be treated as "restored" until an
  operator has manually confirmed and corrected the database state.)
  │
  ▼
OPERATOR_MANUAL_RESTORATION (using the exact byte-level backup manifest and per-database evidence recorded before
  the failure — the same rollout-restore.py mechanics the automatic path uses, invoked by hand, database by
  database if necessary, until every database's SHA-256 matches its manifest entry)
  │
  ▼
VERIFY_RESTORED_COHORT (same check as the FAILED_RESTORED path — only once this passes does the system reach the
  equivalent of FAILED_RESTORED and proceed via retry/abandon as above)

STOPPED_PRESERVED (services stopped after a post-start failure. State: database IS on the NEW schema — migration
  and validation already succeeded before start was attempted; code checked out at the NEW commit; services WERE
  started against this pairing and then failed — the only state in this machine where new code + new schema was
  actually running, however briefly, before stopping. No automatic restore was attempted, per the always-manual-
  review rule in §7.)
  │
  ▼
OPERATOR_DECIDES: forward-fix the service issue and restart against the already-migrated new schema (new code +
  new schema — a supported pairing), OR roll back
  │
  ▼ (if rolling back)
OPERATOR_APPROVED_RESTORE_INVOKED (rollout-restore.py, existing mechanics — O_DIRECTORY|O_NOFOLLOW, atomic rename,
  mode/ownership preserved; this is the first restore attempt for this failure path, unlike FAILED_RESTORED where
  it already happened automatically)
  │ restore fails ──▶ RESTORE_INCOMPLETE (same state and manual-restoration path as above)
  ▼
VERIFY_RESTORED_COHORT (same SHA-256-against-manifest check as the FAILED_RESTORED path)
  │
  ▼
PREVIOUS_CODE_CHECKED_OUT (separate, manual: revert the working tree to the previous commit — required before
  restart, since old schema + new code is not a supported pairing, and the code was never reverted by this script)
  │
  ▼
SERVICES_RESTARTED (previous code + restored databases — a pairing that was already proven to work)
```

There is no state in this machine that represents "new code + old schema" running as a supported combination — both `FAILED_RESTORED`'s and `STOPPED_PRESERVED`'s rollback branches explicitly revert code *before* restart, never after. `STOPPED_PRESERVED`'s forward-fix branch is the only path where new code runs against new schema, which is the pairing the migration was for in the first place.

## 10. Phased implementation plan

| Phase | Scope | Depends on |
|---|---|---|
| 4C.1 | This document, reviewed and merged (docs only) | — |
| 4C.2 | `openProductionDb()` added to `src/db.ts`, additive (§6.1); `openDb()` completely unchanged; shared WAL/FK/construction tail extracted into a private helper both call; `MigrationRequiredError`/`DatabaseMissingError`; the five service entrypoints switched to `openProductionDb()`; **deny-by-default** arch-lint rule prohibiting `openDb` under all of production `src/` except `src/db.ts` itself, not a five-file allowlist (§6.6); characterization tests proving every existing `openDb()` call site (tests, dev tooling, `rollout-db.ts`) is unaffected; new tests for `openProductionDb()`'s legacy-fails-closed and missing-file-fails-closed paths | 4C.1 |
| 4C.3 | New `rollout-db.ts bootstrap` mode (§2, §3) reusing `openDb()`'s existing missing-file path at the database layer, plus new root-owned allowlist/ownership/atomic-creation/cleanup-on-failure machinery at the rollout-helper level; per-database resolving-units evidence field. `rollout-db.ts migrate` itself is unchanged. | 4C.2 |
| 4C.4 | `rollout-agent-bridge.sh` interrupted-rollout sentinel: lock-then-sentinel ordering (§6.4); the explicit `sentinel_removable` flag (§7) gated on re-proven containment, not just "which phase failed"; the new `RESTORE_INCOMPLETE` state (§9) for a failed or unverified automatic restore, distinct from `FAILED_RESTORED` | 4C.3 (can proceed in parallel with 4C.3 if reviewed as a separate PR) |
| 4C.5 | Full test/UAT matrix (§11) executed against a non-production fixture environment, including a UAT case proving the *already-existing* whole-cohort restore-on-migration-failure behavior (§7) under a real induced failure, and separate UAT cases for all three §9 rollback paths (`FAILED_RESTORED`, `RESTORE_INCOMPLETE`, `STOPPED_PRESERVED`) | 4C.2–4C.4 merged |
| 4C.6 | This issue's Phase 4C acceptance criteria reviewed and checked off; Issue #135 updated | 4C.5 |
| 4C.7 | Separately authorized production deployment (§12 runbook) | 4C.6, explicit human approval |

Each of 4C.2–4C.4 is its own draft PR through the same review discipline as PRs #147/#154 (red-green-refactor, full parallel+serial suite, arch-lint, exact-head CI, no merge without explicit approval).

## 11. Test and UAT matrix

| Case | Level | Proves |
|---|---|---|
| Every existing `openDb()` call site across `test/*.ts` and `scripts/rollout-db.ts` | Full regression suite (must stay green throughout 4C.2) | `openDb()` is genuinely untouched — no test rewrite, no behavior change |
| `openProductionDb()` on a `current`-version DB | Unit (new) | Starts normally, same as `openDb()` would |
| `openProductionDb()` on a `future`-version DB | Unit (new) | Fails closed before WAL, `UnsupportedSchemaVersionError` |
| `openProductionDb()` on a `legacy`-version (`user_version = 0`) DB | Unit (new, must be red before 4C.2, green after) | Fails closed with `MigrationRequiredError`; no WAL/write occurs (mirrors the PR #147 future-version test's sidecar-file assertions) |
| `openProductionDb()` on a missing file | Unit (new, must be red before 4C.2, green after) | `fileMustExist: true` prevents implicit creation; no directory or file appears on disk (assert via `existsSync` before/after, mirroring the sidecar-file pattern above) |
| The five service entrypoints, each importing `openDb` directly instead of `openProductionDb` | Arch-lint regression (new) | The known five files are still caught |
| A fixture **non-entrypoint** `src/` module (not one of the five known files) importing `openDb` directly | Arch-lint regression (new) | The rule is genuinely deny-by-default across production `src/`, not scoped to five specific filenames — this is the case an earlier draft's narrower rule would have missed entirely |
| `rollout-db.ts inspect` on the real five-role shape, with shared antigravity/claude/codex path | Integration (new) | Canonicalisation correctly collapses three units to one database, no double-processing |
| `rollout-db.ts bootstrap` on a genuinely missing database | Integration (new) | New role creation works via the existing `openDb()` migration-plan path, distinct from ordinary `migrate` — never triggered implicitly by `inspect`/`migrate`/`validate` |
| `rollout-agent-bridge.sh` failing after `stop_attempted=1` but where containment is independently re-proven | UAT, non-production fixture environment (new) | `sentinel_removable=true` even though the phase-level failure occurred after the stop attempt — removability is gated on containment, not phase, per §7's corrected logic |
| `rollout-agent-bridge.sh` failing after `stop_attempted=1` where containment **cannot** be re-proven | UAT, non-production fixture environment (new) | `sentinel_removable=false` in this case — the earlier draft's blanket "containment failure = removable" would have wrongly cleared the sentinel here |
| `rollout-agent-bridge.sh` with one of five databases deliberately made unmigratable (e.g. injected FK violation, per PR #147's `foreign_key_check` gate) | Integration/UAT (new) | The **existing** whole-cohort restore (via `on_exit`'s `start_attempted == 0` check, §7) actually triggers under a real failure, lands in `FAILED_RESTORED`, and `sentinel_removable` is correctly set only after verified restoration |
| Same as above, but `restore_backups` itself is forced to fail | UAT, non-production fixture environment (new) | The run lands in the new `RESTORE_INCOMPLETE` state (§9), not `FAILED_RESTORED` — `sentinel_removable` stays false, and the state is distinguishable from a genuinely restored cohort |
| Two concurrent `rollout-agent-bridge.sh` invocations racing for the lock, one with a prior failed run's sentinel present | UAT, non-production fixture environment (new) | The corrected lock-then-sentinel ordering (§6.4) actually closes the race, not just on paper |
| `rollout-agent-bridge.sh` killed mid-`MIGRATING` (simulated) | UAT, non-production fixture environment | Sentinel present on next invocation; hard stop; no auto-resume in either direction |
| `rollout-agent-bridge.sh` full run against a five-database fixture cohort seeded with realistic legacy shapes (reuse PR #147's fixed pre-versioned SQL fixtures) | UAT, non-production fixture environment | End-to-end containment → backup → migrate → validate → start → verify, matching `docs/GUARDED-ROLLOUT.md`'s documented sequence exactly |
| Full rollback drill, `FAILED_RESTORED` path: fixture cohort, forced mid-migration failure, automatic restore, verify byte-identical to pre-migration backup via SHA-256, confirm code is reverted to the previous commit *before* restart | UAT, non-production fixture environment | Locked decisions 3, 4, 5, and 7 hold under a real (if fixture-scale) failure; §9's `FAILED_RESTORED` path is followed, and new-code-against-restored-schema is never started |
| Full rollback drill, `RESTORE_INCOMPLETE` path: fixture cohort, forced automatic-restore failure, manual operator restoration, verify the cohort only proceeds once every database's SHA-256 matches | UAT, non-production fixture environment (new) | §9's distinct `RESTORE_INCOMPLETE` state is actually exercised, not silently conflated with `FAILED_RESTORED` |
| Full rollback drill, `STOPPED_PRESERVED` path: fixture cohort, forced post-start service failure, manual operator-approved restore invocation, confirm code is reverted before restart | UAT, non-production fixture environment (new) | §9's distinct `STOPPED_PRESERVED` path — database on new schema, no automatic restore, requires explicit operator invocation — is actually exercised, not conflated with either path above |
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
