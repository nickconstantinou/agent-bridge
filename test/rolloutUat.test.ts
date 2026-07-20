// Phase 4C.5 (issue #135): UAT matrix against a non-production fixture
// environment (docs/roadmap/issue-135-phase4c-migration-ownership.md §11,
// rows tagged "UAT, non-production fixture environment").
//
// Unlike test/rolloutHelper.test.ts (which fakes `systemctl` entirely),
// every test in this file drives *real* `systemd --user` units: real
// process start/stop, real ActiveState/SubState/ExecMainStatus, real
// cgroups, real SIGTERM/SIGKILL semantics. `runuser`/`cp`/`journalctl`/
// `rollout-restore` stay fixture-shimmed for the same reason the existing
// suite shims them (no real "rollout-test" OS user, no desire to touch
// the real cgroup root) — that shimming is infrastructure necessity, not
// a shortcut around the logic under test: outside an explicitly injected
// failure phase, the `runuser` shim `exec`s the real `rollout-db.ts`
// against real SQLite databases.
//
// Gated behind AGENT_BRIDGE_REAL_SYSTEMD_TEST=1, matching the one
// existing real-systemd test in rolloutHelper.test.ts, so ordinary CI
// runs (which may not have a user systemd session) stay fast and skip
// this file entirely.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRealSystemdLock,
  cleanupRoots,
  createFixture,
  executable,
  type Fixture,
  helperPath,
  metadata,
  runRestore,
  runRollout,
  sentinelClearPath,
  sha256,
  units,
} from "./support/rolloutFixture";

const REAL_SYSTEMD = process.env.AGENT_BRIDGE_REAL_SYSTEMD_TEST === "1";

afterEach(cleanupRoots);

const runtimeDir = `/run/user/${process.getuid?.() ?? 0}`;
const userEnv = {
  ...process.env,
  XDG_RUNTIME_DIR: runtimeDir,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
};

function systemctlUser(args: string[]) {
  return spawnSync("systemctl", ["--user", ...args], { env: userEnv, encoding: "utf8" });
}

/** Swaps the fixture's fake `systemctl` for a shim that forwards real
 * lifecycle commands (stop/start/is-active/is-failed/reset-failed) to a
 * genuine `systemctl --user` session, while still canning the two
 * config-introspection properties the script needs (EnvironmentFiles,
 * Environment) — a transient `systemd-run` unit has no on-disk
 * EnvironmentFile= the way a real installed unit would.
 */
function useRealSystemctl(fixture: Fixture): void {
  rmSync(fixture.cgroupRoot, { recursive: true, force: true });
  symlinkSync("/sys/fs/cgroup", fixture.cgroupRoot, "dir");
  executable(join(fixture.root, "bin", "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
echo "systemctl:$*" >> "${fixture.actionLog}"
export XDG_RUNTIME_DIR="${runtimeDir}"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${runtimeDir}/bus"
if [ "\${1:-}" = show ] && [[ " $* " == *" --property=EnvironmentFiles "* ]]; then
  printf '%s\n%s\n' "${fixture.envDir}/agent-bridge-shared (ignore_errors=yes)" "${fixture.envDir}/\${2%.service} (ignore_errors=no)"
elif [ "\${1:-}" = show ] && [[ " $* " == *" --property=Environment "* ]]; then
  echo NODE_ENV=production
else
  exec /usr/bin/systemctl --user "$@"
fi
`);
}

/** Starts one real, long-lived, TERM-trapping placeholder unit per
 * configured service name, as genuine unit files under the runtime user's
 * systemd directory — not `systemd-run` transients, which systemd garbage
 * -collects entirely once stopped, making a subsequent `systemctl start`
 * fail with "Unit not found". A real installed unit (which is what every
 * agent-bridge production service actually is) survives stop/start cycles,
 * which several of these UAT drills genuinely exercise. Returns a teardown
 * that stops every unit, clears failed state, and removes the unit files.
 */
async function startRealUnits(unitNames: string[]): Promise<() => void> {
  const unitDir = join(runtimeDir, "systemd", "user");
  const unitFiles: string[] = [];
  for (const unit of unitNames) {
    const unitFile = join(unitDir, unit);
    unitFiles.push(unitFile);
    executable(unitFile, `[Service]
Type=simple
Restart=no
ExecStart=/bin/sh -c "trap 'exit 143' TERM; while :; do sleep 1; done"
`);
  }
  systemctlUser(["daemon-reload"]);
  for (const unit of unitNames) {
    execFileSync("systemctl", ["--user", "start", unit], { env: userEnv });
  }
  for (const unit of unitNames) {
    const deadline = Date.now() + 5_000;
    while (systemctlUser(["show", unit, "-p", "ActiveState", "--value"]).stdout.trim() !== "active") {
      if (Date.now() >= deadline) throw new Error(`real systemd fixture for ${unit} did not become active`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return () => {
    for (const unit of unitNames) {
      systemctlUser(["stop", unit]);
      systemctlUser(["reset-failed", unit]);
    }
    for (const unitFile of unitFiles) rmSync(unitFile, { force: true });
    systemctlUser(["daemon-reload"]);
  };
}

/** Restarts every unit for real, clearing failed state first — the same
 * two-step sequence rollout-agent-bridge.sh itself performs before start.
 */
function restartRealUnits(unitNames: string[]): void {
  for (const unit of unitNames) {
    systemctlUser(["reset-failed", unit]);
    execFileSync("systemctl", ["--user", "start", unit], { env: userEnv });
  }
}

function isActive(unit: string): boolean {
  return systemctlUser(["is-active", "--quiet", unit]).status === 0;
}

describe.runIf(REAL_SYSTEMD)("Phase 4C.5 UAT — real systemd, non-production fixture environment (issue #135)", () => {
  let releaseSystemdLock: () => void;
  beforeEach(async () => {
    releaseSystemdLock = await acquireRealSystemdLock();
  });
  afterEach(() => releaseSystemdLock());

  it(
    "runs a full successful rollout across all seven real units and five databases",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(units);
      try {
        const before = fixture.dbPaths.map(sha256);
        const result = runRollout(fixture);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
        for (const unit of units) expect(isActive(unit), unit).toBe(true);
        const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
        expect(readFileSync(join(artifacts, "rollout.log"), "utf8")).toContain("rollout completed");
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel must be gone after DONE").toBe(false);
      } finally {
        teardown();
      }
    },
    30_000,
  );

  it(
    "STOPPED_UNCHANGED full rollback drill: real stop-then-backup failure, manual revert, real restart, then a fresh rollout succeeds",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(units);
      try {
        const before = fixture.dbPaths.map(sha256);
        const failed = runRollout(fixture, "backup");
        const output = `${failed.stdout}\n${failed.stderr}`;
        expect(failed.status).not.toBe(0);
        expect(output).toMatch(/STATE: STOPPED_UNCHANGED/);
        expect(fixture.dbPaths.map(sha256)).toEqual(before);
        for (const unit of units) expect(isActive(unit), `${unit} must be genuinely stopped`).toBe(false);
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel retained").toBe(true);

        // A bare re-invocation must not be able to proceed: blocked by the
        // sentinel first, and assert_service_active would reject it even
        // if it weren't.
        const bareRetry = runRollout(fixture);
        expect(bareRetry.status).not.toBe(0);
        expect(`${bareRetry.stdout}\n${bareRetry.stderr}`).toMatch(/interrupted rollout sentinel already exists/i);
        for (const unit of units) expect(isActive(unit)).toBe(false);

        // §9 recovery flow: clear the sentinel, "revert code" (no-op here,
        // fixture never advances past one commit), restart the previous
        // services for real, confirm active — then a fresh rollout succeeds.
        const sentinelContent = readFileSync(join(fixture.logDir, ".rollout-in-progress"), "utf8");
        const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;
        const clear = spawnSync("bash", [sentinelClearPath, "--expected-commit", fixture.expectedCommit, "--artifact-dir", recordedArtifactDir], {
          encoding: "utf8",
          env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root },
        });
        expect(clear.status, `${clear.stdout}\n${clear.stderr}`).toBe(0);

        restartRealUnits(units);
        for (const unit of units) expect(isActive(unit), `${unit} must be restarted before retry`).toBe(true);

        const retry = runRollout(fixture);
        expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
        expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
      } finally {
        teardown();
      }
    },
    30_000,
  );

  it(
    "FAILED_RESTORED full rollback drill: real migrate-phase failure, automatic whole-cohort restore verified byte-identical, code still on new commit, services remain stopped",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(units);
      try {
        const before = fixture.dbPaths.map(metadata);
        const result = spawnSync("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
          encoding: "utf8",
          env: {
            ...process.env,
            AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
            FAKE_FAIL_PHASE: "migrate",
            FAKE_CORRUPT_DB: fixture.dbPaths[0],
          },
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status).not.toBe(0);
        expect(output).toMatch(/STATE: FAILED_RESTORED/);
        expect(fixture.dbPaths.map(metadata)).toEqual(before);
        for (const unit of units) expect(isActive(unit), `${unit} must remain stopped — FAILED_RESTORED never auto-restarts`).toBe(false);
        // Code is still checked out at the new (target) commit — the
        // helper never reverts it; that is always a separate manual step.
        expect(execFileSync("git", ["-C", fixture.project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(fixture.expectedCommit);
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel removed once restoration is verified").toBe(false);
      } finally {
        teardown();
      }
    },
    30_000,
  );

  it(
    "RESTORE_INCOMPLETE full rollback drill: real migrate-phase failure where the automatic restore itself fails, then manual per-database operator restoration until every SHA-256 matches",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(units);
      try {
        const before = fixture.dbPaths.map(sha256);
        const result = spawnSync("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
          encoding: "utf8",
          env: {
            ...process.env,
            AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
            FAKE_FAIL_PHASE: "migrate",
            FAKE_CORRUPT_DB: fixture.dbPaths[0],
            FAKE_RESTORE_FAIL: "1",
          },
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status).not.toBe(0);
        expect(output).toMatch(/STATE: RESTORE_INCOMPLETE/);
        for (const unit of units) expect(isActive(unit)).toBe(false);
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel retained — restoration unverified").toBe(true);

        // State is deliberately unknown/mixed here — this must never be
        // treated as "restored" until an operator manually confirms and
        // corrects it, database by database, using the exact same
        // rollout-restore.py mechanics the automatic path uses.
        const artifactDir = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
        const manifestRows = readFileSync(join(artifactDir, "backup-manifest.tsv"), "utf8")
          .trim().split("\n").slice(1)
          .map((line) => line.split("\t"));
        expect(manifestRows).toHaveLength(fixture.dbPaths.length);
        for (const [, source, backup] of manifestRows) {
          const restore = runRestore(source, backup);
          expect(restore.status, `${source}: ${restore.stdout}\n${restore.stderr}`).toBe(0);
          rmSync(`${source}-wal`, { force: true });
          rmSync(`${source}-shm`, { force: true });
        }
        // The cohort only "proceeds" once every database's SHA-256 matches
        // its manifest entry — verify that directly, not just trust the
        // restore tool's own exit code.
        for (const [, source, backup] of manifestRows) {
          expect(sha256(source), `${source} must match its manifest backup after manual restoration`).toBe(sha256(backup));
        }
        expect(fixture.dbPaths.map(sha256)).toEqual(before);

        const sentinelContent = readFileSync(join(fixture.logDir, ".rollout-in-progress"), "utf8");
        const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;
        const clear = spawnSync("bash", [sentinelClearPath, "--expected-commit", fixture.expectedCommit, "--artifact-dir", recordedArtifactDir], {
          encoding: "utf8",
          env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root },
        });
        expect(clear.status, `${clear.stdout}\n${clear.stderr}`).toBe(0);

        restartRealUnits(units);
        for (const unit of units) expect(isActive(unit), `${unit} must be restarted after manual restoration`).toBe(true);

        const retry = runRollout(fixture);
        expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
      } finally {
        teardown();
      }
    },
    30_000,
  );

  it(
    "STOPPED_PRESERVED full rollback drill: real post-start failure, database stays on the NEW schema with no automatic restore, then an explicit operator-approved restore reverts every database and services restart cleanly",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(units);
      try {
        const before = fixture.dbPaths.map(sha256);

        // Real start (all seven units genuinely come up); the failure is
        // injected only at the post-start journal smoke check, so this is
        // a genuine "new code + new schema, briefly running" scenario —
        // the one state in the whole machine where that pairing is live.
        const result = spawnSync("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
          encoding: "utf8",
          env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root, FAKE_FAIL_PHASE: "smoke" },
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status).not.toBe(0);
        expect(output).toMatch(/STATE: STOPPED_PRESERVED/);
        for (const unit of units) expect(isActive(unit), `${unit} must be stopped again after the post-start failure`).toBe(false);
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel retained — always requires operator review").toBe(true);

        // Database IS on the new schema — migration and validation already
        // succeeded before start was attempted — and no automatic restore
        // was attempted (that's the whole point of this state).
        const afterFailure = fixture.dbPaths.map(sha256);
        expect(afterFailure, "databases must be genuinely migrated, not reverted").not.toEqual(before);

        const artifactDir = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
        const manifestRows = readFileSync(join(artifactDir, "backup-manifest.tsv"), "utf8")
          .trim().split("\n").slice(1)
          .map((line) => line.split("\t"));
        expect(manifestRows).toHaveLength(fixture.dbPaths.length);
        for (const [, source, backup] of manifestRows) {
          expect(sha256(source), `${source} must still be on the new (migrated) schema, not equal to its pre-migration backup`).not.toBe(sha256(backup));
        }

        // Explicit operator-approved restore: the same rollout-restore.py
        // mechanics the automatic FAILED_RESTORED path uses, but invoked
        // manually per database — this state never triggers it itself.
        // rollout-restore.py only replaces the main database file; the
        // caller (normally restore_backups() inside the script) is
        // responsible for clearing stale -wal/-shm sidecars from the
        // schema being abandoned — replicate that same operator step here.
        for (const [, source, backup] of manifestRows) {
          const restore = runRestore(source, backup);
          expect(restore.status, `${source}: ${restore.stdout}\n${restore.stderr}`).toBe(0);
          rmSync(`${source}-wal`, { force: true });
          rmSync(`${source}-shm`, { force: true });
        }
        expect(fixture.dbPaths.map(sha256), "every database must match its pre-migration state after the operator-approved restore").toEqual(before);

        // Revert to previous code before restarting: a no-op in this
        // fixture (the project never advances past one commit — the same
        // documented limitation the STOPPED_UNCHANGED drill above has),
        // but the ordering itself — restore verified, THEN restart, never
        // the other way round — is what this drill proves.
        restartRealUnits(units);
        for (const unit of units) expect(isActive(unit), `${unit} must be restarted after the restore`).toBe(true);

        // STOPPED_PRESERVED never auto-clears its sentinel (unlike
        // STOPPED_UNCHANGED/FAILED_RESTORED) — the operator must clear it
        // explicitly once they've completed their review and recovery.
        const sentinelContent = readFileSync(join(fixture.logDir, ".rollout-in-progress"), "utf8");
        const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;
        const clear = spawnSync("bash", [sentinelClearPath, "--expected-commit", fixture.expectedCommit, "--artifact-dir", recordedArtifactDir], {
          encoding: "utf8",
          env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root },
        });
        expect(clear.status, `${clear.stdout}\n${clear.stderr}`).toBe(0);

        // The restored pairing is retryable: a fresh rollout succeeds.
        const retry = runRollout(fixture);
        expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
        expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
      } finally {
        teardown();
      }
    },
    30_000,
  );

  it(
    "a real SIGKILL mid-MIGRATING leaves the sentinel retained, services stopped, and a bare retry hard-blocked",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(units);
      let child: ChildProcess | undefined;
      try {
        // detached: true makes this bash process a process-group leader,
        // so killing the whole group (not just this one PID) below reaches
        // any grandchild (the runuser shim's real tsx/node migration
        // child) too. Killing only the top-level PID left that grandchild
        // running long enough to still hold its inherited copy of the
        // lock fd, making the very next assertion flaky — a real gap this
        // UAT test itself caught, not an artifact of the fix.
        child = spawn("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
          env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root },
          stdio: "ignore",
          detached: true,
        });

        const latestPath = join(fixture.logDir, "latest");
        const deadline = Date.now() + 10_000;
        let logFile = "";
        while (!logFile) {
          if (existsSync(latestPath)) {
            const artifactDir = readFileSync(latestPath, "utf8").trim();
            const candidate = join(artifactDir, "rollout.log");
            if (existsSync(candidate) && readFileSync(candidate, "utf8").includes("migrating databases")) {
              logFile = candidate;
              break;
            }
          }
          if (Date.now() >= deadline) throw new Error("rollout never reached the migrate phase in time");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        const pid = child.pid!;
        process.kill(-pid, "SIGKILL");
        await new Promise<void>((resolve) => child!.once("close", () => resolve()));
        child = undefined;

        // Belt-and-braces: wait until the lock file is genuinely
        // acquirable again before asserting on the retry's specific
        // failure message, so this test's own timing can never flake on
        // "how long a killed process group takes to fully disappear" —
        // only the script's own sentinel/lock behavior is under test here.
        const lockDeadline = Date.now() + 5_000;
        for (;;) {
          const probe = spawnSync("bash", ["-c", `exec 9>"${fixture.lockFile}"; flock --exclusive --nonblock 9 && flock --unlock 9`]);
          if (probe.status === 0) break;
          if (Date.now() >= lockDeadline) throw new Error("lock file never became acquirable after the kill — an orphaned process may still hold it");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        // A killed process cannot run its own EXIT trap — the sentinel is
        // exactly what makes this interruption visible and unrecoverable
        // by accident, instead of silently vanishing.
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel must survive a SIGKILL — nothing ran to remove it").toBe(true);
        for (const unit of units) expect(isActive(unit), `${unit} must still be stopped after the kill`).toBe(false);

        // Deliberately no assertion about database content here: a kill
        // mid-migrate leaves genuinely indeterminate state (the migration
        // loop could have been anywhere across the five databases) — that
        // is exactly why the sentinel forces a hard stop for manual
        // review rather than an automatic retry, not something this test
        // should paper over with a guess.
        const bareRetry = runRollout(fixture);
        expect(bareRetry.status).not.toBe(0);
        expect(`${bareRetry.stdout}\n${bareRetry.stderr}`).toMatch(/interrupted rollout sentinel already exists/i);
        for (const unit of units) expect(isActive(unit), `${unit} must still be stopped — the blocked retry never touched services`).toBe(false);
      } finally {
        if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
        teardown();
      }
    },
    30_000,
  );
});
