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

## 2. Startup behaviour matrix

Applies to `openDb()` as called from the five ordinary-startup entrypoints (`src/index.ts`, `src/index-worker.ts`, `src/index-interactive.ts`, `src/index-discord-interactive.ts`, `src/index-health.ts`).

| Schema state (`user_version`) | Current behaviour (PR #147) | Required behaviour (this policy) |
|---|---|---|
| `current` (`== CURRENT_SCHEMA_VERSION`) | Starts normally | Unchanged — starts normally |
| `legacy` (`0`, file exists) | Auto-migrates transactionally, then starts | **Fails closed** before WAL mode or any write, with an error identifying the required rollout action. Does not migrate. |
| `migratable` (`0 < user_version < CURRENT_SCHEMA_VERSION`, once multi-step migrations exist) | N/A today (only versions 0 and 1 exist) | Same as legacy — fails closed, does not migrate |
| `future` (`> CURRENT_SCHEMA_VERSION`) | Fails closed before WAL, connection closed, error thrown | Unchanged — this is already correct and is the template the legacy case is being brought in line with |
| Negative / non-integer | Fails closed before WAL (per PR #147 round-2 review fix) | Unchanged |
| **Missing file** | `new Database(dbPath)` (better-sqlite3 default mode) creates the file on disk as an empty, `user_version = 0` database *before* the version pragma is even read — `mkdirSync` of the parent directory happens one line earlier still. The strict legacy gate above would then reject this newly-created file as "legacy," but the file-creation write already happened, contradicting "fails without writing." | **`openDb()` must open in explicit non-creating mode** (better-sqlite3 `{ fileMustExist: true }`) so a missing database fails closed with a distinct `DatabaseMissingError` — no directory or file is created by ordinary startup, ever. First-run bootstrap is a separate, explicit rollout-helper action (§6.5), not an implicit `openDb()` side effect. |

## 3. Rollout-time behaviour matrix

Applies to `scripts/rollout-db.ts`'s `inspect` / `migrate` / `validate` modes, invoked only from `scripts/rollout-agent-bridge.sh` after containment is proven (guarded rollout helper phase 4 in `docs/GUARDED-ROLLOUT.md`).

| Mode | Current behaviour | Required behaviour |
|---|---|---|
| `inspect` | Read-only schema/integrity/queue evidence per database; `fileMustExist: true`; aborts if any legacy queue count is nonzero | Unchanged, plus: cross-check that the resolved database set, once canonicalised (§4), matches the expected five-role inventory exactly — extra or missing canonical paths abort before backup |
| `migrate` | Calls `openDb(path, ...)` directly per database in a plain loop — a mid-loop failure propagates immediately and does not attempt the remaining databases (already fail-fast; verified by reading the loop, no per-database try/catch) | Calls a **new, narrowly-owned migration entry point** (§6.1, §6.6 — not the ordinary `openDb()`), only reachable from `scripts/rollout-db.ts` and its own tests, enforced by an architecture test rather than by naming convention alone. Same fail-fast, no-partial-continuation, transactional/FK-check guarantees as today — this is a narrowing of *who may call it*, not a change to *what it does on failure*. |
| `validate` | Re-inspects each database and requires `schema === "current"` | Unchanged |
| **First-run bootstrap** (new mode) | Not supported — `rollout-agent-bridge.sh` requires every discovered database to already exist (`[[ -f "$discovered" ]] || die ...`) before acquiring the lock, and `rollout-db.ts inspect`/`migrate`/`validate` all open with `fileMustExist: true` | **New, explicitly separate `bootstrap` mode**: only for a database file that is genuinely absent (not merely legacy), creates it at `CURRENT_SCHEMA_VERSION` directly (no legacy DDL path — a brand-new role has no history to repair), with the same ownership/mode discipline the rollout helper already applies to backups. Never invoked implicitly by `inspect`/`migrate`/`validate`, and never bundled into the same invocation as a migration of *existing* databases — no pre-migration backup exists for a database that didn't exist, so it cannot participate in the whole-cohort restore guarantee (locked decision 7) the same way. Requires explicit operator confirmation that the missing file is expected (new role), not a symptom of misconfiguration or accidental deletion. |

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
| Schema migration execution | `src/db/rolloutMigration.ts` (new, narrow module — §6.1), called only from `scripts/rollout-db.ts` `migrate` mode, invoked only by `scripts/rollout-agent-bridge.sh`; ownership enforced by arch-lint, not just convention (§6.6) | `openDb()` under ordinary startup; any service; any ad hoc script |
| First-run database bootstrap | `scripts/rollout-db.ts` `bootstrap` mode (new — §2, §3, §6.5), never invoked implicitly | `openDb()` under ordinary startup (must `fileMustExist`, never create); `migrate`/`inspect`/`validate` modes |
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

1. **`src/db.ts`: split the migration entry point, and open in non-creating mode.**
   `openDb()` (used by all five ordinary entrypoints) opens with better-sqlite3's `{ fileMustExist: true }` (so a missing database fails closed as `DatabaseMissingError` — see §2 — instead of being silently created), and changes its version gate from "reject only `> CURRENT_SCHEMA_VERSION`" to "reject anything that is not exactly `CURRENT_SCHEMA_VERSION`" — i.e. legacy now fails closed too, with a distinct, actionable error (`MigrationRequiredError`, separate from `UnsupportedSchemaVersionError`, so operators and logs can tell "you're behind" from "you're ahead/corrupt" at a glance). Both new errors are thrown before any pragma that could create/mutate the file.

   A new, narrowly-scoped **migration module** (not a general export of `src/db.ts` — see item 6 below for how "narrow" is enforced, not just asserted) retains today's `openDb()` auto-migrate behavior and is the only thing `rollout-db.ts migrate` mode may call. Both entry points share the same `applyMigrations()`/`legacyBaselineMigration.ts` internals; only the entry point, file-open mode, and version-gate strictness differ. Verified by grep across `test/*.ts`: only `test/dbSchema.test.ts` exercises legacy-fixture migration through `openDb()`, and every one of those cases is exactly the migration-path testing that moves to the new module under 4C.2 — no other test relies on ordinary `openDb()` auto-migrating a legacy database as a success path, so this is a pure narrowing, not a behavior removal any other caller depends on. Re-verify this grep at 4C.2 implementation time in case new tests have landed since this document was written.

2. **`rollout-db.ts`: switch `migrate` mode to the new migration module.** No change to its existing fail-fast behavior (confirmed by reading the current implementation: a plain loop over databases with no per-database try/catch, so a failure on database N already stops before attempting N+1 — this is preserved, not newly added).

3. **`rollout-db.ts inspect`: add per-database "resolving units" evidence field** (§4), sourced from the same unit/env resolution `rollout-agent-bridge.sh` already performs — pass the resolved unit→path mapping into `rollout-db.ts` as evidence input rather than re-deriving it.

4. **`rollout-agent-bridge.sh`: add an explicit interrupted-rollout guard (locked decision 8), ordered to avoid a check-then-act race.** The check-for-stale-sentinel-before-acquiring-the-lock design considered earlier has a race: a second invocation could observe no sentinel, then acquire the lock only after a third invocation has already failed and left one behind, and proceed without ever re-checking. Corrected order, all under the *existing* `flock --exclusive --nonblock` at the point already in the script (line ~192, before any precondition check runs):
   1. Acquire the exclusive `flock` (unchanged — this is the sole serialization point; nothing new needed here).
   2. Immediately after acquiring it, inspect the sentinel path. If a sentinel exists, abort with an instruction to review the prior run's evidence before manually clearing it — this check now happens under the same lock a concurrent invocation would also need, so there is no window between "checked" and "acted."
   3. Atomically create the new sentinel (e.g. `O_CREAT|O_EXCL`) before any precondition check proceeds.
   4. Remove the sentinel only on a clean terminal outcome: full success, or a fully-evidenced, fully-restored failure (`on_exit`'s existing `restore_backups` path completing with `status == 0`). Any other exit leaves the sentinel in place — deliberately, per locked decision 8.

5. **New `bootstrap` mode for genuinely missing databases (§2, §3).** Explicitly separate invocation from ordinary migration; never runs implicitly.

6. **Enforce sole-ownership of the migration module with a static check, not a naming convention.** A comment saying "only `rollout-db.ts` may call this" is not a boundary — nothing stops a future service module from importing it directly, and Phase 4B already established the precedent (`scripts/sqlOwnershipLint.mjs`, PRs #147/#154) that this codebase backs ownership claims with enforcement, not documentation alone. Concretely: place the migration module somewhere its import path signals restriction (e.g. `src/db/rolloutMigration.ts`, mirroring `src/db/legacyBaselineMigration.ts`'s existing "internal to the migration boundary" placement), add an architecture-lint rule restricting its imports to `scripts/rollout-db.ts` and its own test file (same allowlist-plus-marker pattern `scripts/sqlOwnershipLint.mjs` already uses), and add a regression test asserting that none of the five ordinary-startup entrypoints (or any other `src/` module) import it — run as part of the same `bash scripts/arch-lint.sh src` gate already in CI.

7. **No change to:** containment proof, backup/restore mechanics, `--expected-commit` exact-SHA requirement, sudoers/config model, or the "legacy queue discard is unsupported" rule.

## 7. Failure and interruption semantics

| Failure point | Current helper behavior | This policy |
|---|---|---|
| Precondition/containment failure (before backup) | Aborts, no rollback needed (nothing touched yet) | Unchanged |
| Backup failure | Aborts before migration; databases untouched | Unchanged |
| Migration or validation failure (mid-`migrate`/`validate` across the five databases) | **Already whole-cohort restore, verified by reading the script, not assumed:** `start_attempted` is set to `1` only after both `migrate` and `validate` complete (line ~445, after the migrate/validate calls at lines ~438–441). The `on_exit` trap fires on any nonzero exit and, when `start_attempted == 0` and a backup manifest exists, calls `restore_backups` for the *entire* manifest — not per-database. `rollout-db.ts migrate`'s own plain-loop fail-fast (item 2 above) means a mid-cohort failure stops there and lets this existing trap handle the whole-cohort restore. | **No new implementation required here — the earlier draft of this section incorrectly described this as unhandled/to-be-built.** What's needed is a UAT case (§11) proving it under a real induced failure, since it's currently exercised only by code-reading, not a test. |
| Post-migration, post-validation, pre-start failure | Same trap: `start_attempted` is still `0` at this point, so this is *also* already whole-cohort restore, not "preserved" as the earlier draft stated. | Corrected description only — no behavior change. |
| Post-start failure (service won't come up on new schema) | `start_attempted == 1` by this point, so the trap does *not* restore — migrated databases, evidence, and the failed service state are preserved for operator review (existing, and correctly distinct from the pre-start cases above: once a service has started against the new schema, an automatic DB rollback could race with in-flight writes, so this one genuinely does require manual judgment). | Unchanged |
| Process killed / machine rebooted mid-rollout | Not explicitly guarded today | **New: interrupted-rollout sentinel (§6.4) forces a hard stop and manual review on the next invocation — never an automatic resume in either direction.** |

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
  │ fail: release lock, sentinel remains, exit nonzero
  ▼
CONTAINMENT_PROVEN
  │ fail: release lock, sentinel remains, exit nonzero — nothing touched
  ▼
BACKED_UP (all five)
  │ fail: release lock, sentinel remains, exit nonzero — databases untouched
  ▼
MIGRATING (all five, via the narrow migration module, §6.1/§6.6; plain fail-fast loop, no partial continuation)
  │ any failure ──▶ RESTORING (all five, existing on_exit trap — start_attempted still 0) ──▶ FAILED_RESTORED (sentinel remains, exit nonzero)
  ▼ all five succeed
VALIDATED (all five == CURRENT_SCHEMA_VERSION, requireCurrent check passes)
  │ fail ──▶ RESTORING (all five, same trap) ──▶ FAILED_RESTORED (sentinel remains)
  ▼
STARTING (all seven units; start_attempted set to 1 here — trap no longer restores past this point)
  │ fail ──▶ STOPPED_PRESERVED (sentinel remains present — not removed; migrated DBs + evidence preserved, no auto-rollback, operator review required)
  ▼
VERIFIED_ACTIVE ──▶ DONE (sentinel removed only here, on a clean terminal outcome)
```

Interrupted at any state before `DONE`: the sentinel was created immediately after lock acquisition and is only ever removed on `DONE`, so it remains present through every failure path above. The next invocation acquires the lock, finds the sentinel under that same lock (no race), hard-stops, and requires manual review (§6.4) — it does not attempt to infer which state was reached and resume.

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
| 4C.2 | `src/db/rolloutMigration.ts` split out from `src/db.ts` (§6.1, §6.6); `openDb()` gains `{ fileMustExist: true }` and the strict legacy/missing gates; `MigrationRequiredError`/`DatabaseMissingError`; arch-lint import-restriction rule + regression test enforcing sole ownership (§6.6); full-repo grep confirming no caller relies on ordinary-open auto-migration of a legacy DB; characterization tests locking current `future`/`current` behavior unchanged, new tests for the legacy-fails-closed and missing-file-fails-closed paths | 4C.1 |
| 4C.3 | `rollout-db.ts` switched to the new migration module; new `bootstrap` mode (§2, §3, §6.5) for genuinely missing databases; per-database resolving-units evidence field | 4C.2 |
| 4C.4 | `rollout-agent-bridge.sh` interrupted-rollout sentinel, created under the existing `flock` (§6.4), not before it | 4C.3 (can proceed in parallel with 4C.3 if reviewed as a separate PR) |
| 4C.5 | Full test/UAT matrix (§11) executed against a non-production fixture environment, including a UAT case proving the *already-existing* whole-cohort restore-on-migration-failure behavior (§7) under a real induced failure | 4C.2–4C.4 merged |
| 4C.6 | This issue's Phase 4C acceptance criteria reviewed and checked off; Issue #135 updated | 4C.5 |
| 4C.7 | Separately authorized production deployment (§12 runbook) | 4C.6, explicit human approval |

Each of 4C.2–4C.4 is its own draft PR through the same review discipline as PRs #147/#154 (red-green-refactor, full parallel+serial suite, arch-lint, exact-head CI, no merge without explicit approval).

## 11. Test and UAT matrix

| Case | Level | Proves |
|---|---|---|
| Ordinary `openDb()` on a `current`-version DB | Unit (characterization, must stay green) | No regression from the split |
| Ordinary `openDb()` on a `future`-version DB | Unit (characterization, must stay green) | Existing fail-closed-before-WAL behavior unchanged |
| Ordinary `openDb()` on a `legacy`-version (`user_version = 0`) DB | Unit (new, must be red before 4C.2, green after) | New fail-closed behavior; no WAL/write occurs (mirrors the PR #147 future-version test's sidecar-file assertions) |
| Ordinary `openDb()` on a missing file | Unit (new, must be red before 4C.2, green after) | `fileMustExist: true` prevents implicit creation; no directory or file appears on disk (assert via `existsSync` before/after, mirroring the sidecar-file pattern above) |
| Migration module on a `legacy` DB | Unit (moved from existing `openDb()` tests) | Migration still works exactly as PR #147 proved, just under the new entry point |
| A non-owner `src/` module attempting to import the migration module | Arch-lint regression (new) | Sole-ownership is enforced, not just documented (§6.6) — mirrors `scripts/sqlOwnershipLint.mjs`'s existing pattern from PR #154 |
| `rollout-db.ts inspect` on the real five-role shape, with shared antigravity/claude/codex path | Integration (new) | Canonicalisation correctly collapses three units to one database, no double-processing |
| `rollout-db.ts bootstrap` on a genuinely missing database | Integration (new) | New role creation works and is distinct from migration — never triggered implicitly by `inspect`/`migrate`/`validate` |
| `rollout-agent-bridge.sh` with one of five databases deliberately made unmigratable (e.g. injected FK violation, per PR #147's `foreign_key_check` gate) | Integration/UAT (new) | The **existing** whole-cohort restore (via `on_exit`'s `start_attempted == 0` check, §7) actually triggers under a real failure, not just by code inspection |
| Two concurrent `rollout-agent-bridge.sh` invocations racing for the lock, one with a prior failed run's sentinel present | UAT, non-production fixture environment (new) | The corrected lock-then-sentinel ordering (§6.4) actually closes the race, not just on paper |
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
