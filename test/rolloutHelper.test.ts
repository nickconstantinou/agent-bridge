import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const helperPath = fileURLToPath(new URL("../scripts/rollout-agent-bridge.sh", import.meta.url));
const sentinelClearPath = fileURLToPath(new URL("../scripts/rollout-sentinel-clear.sh", import.meta.url));
const restoreHelperPath = fileURLToPath(new URL("../scripts/rollout-restore.py", import.meta.url));
const migrationScript = fileURLToPath(new URL("../scripts/rollout-db.ts", import.meta.url));
const sourceDir = fileURLToPath(new URL("../src", import.meta.url));
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));

const units = [
  "agent-bridge-antigravity.service",
  "agent-bridge-claude.service",
  "agent-bridge-codex.service",
  "agent-bridge-discord-interactive.service",
  "agent-bridge-health.service",
  "agent-bridge-interactive.service",
  "agent-bridge-worker-bot.service",
];

interface Fixture {
  root: string;
  project: string;
  expectedCommit: string;
  dbPaths: string[];
  actionLog: string;
  stateFile: string;
  backupDir: string;
  logDir: string;
  lockFile: string;
  configFile: string;
  envDir: string;
  cgroupRoot: string;
}

const roots: string[] = [];

function executable(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function createLegacyDb(path: string, pending = 0): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE bridge_state (
      chat_id TEXT PRIMARY KEY,
      codex_session_id TEXT,
      gemini_session_id TEXT,
      claude_session_id TEXT,
      antigravity_session_id TEXT,
      active_execution_lock INTEGER NOT NULL DEFAULT 0,
      last_update_id INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_key TEXT NOT NULL,
      prompt TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      thread_id INTEGER,
      chat_type TEXT NOT NULL DEFAULT 'private',
      user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  for (let index = 0; index < pending; index += 1) {
    db.prepare("INSERT INTO pending_messages (chat_key, prompt, chat_id) VALUES (?, ?, ?)")
      .run(`chat-${index}`, `pending-${index}`, index + 1);
  }
  db.close();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function metadata(path: string) {
  const stat = statSync(path);
  return { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777, size: stat.size, sha256: sha256(path) };
}

function restoreArguments(source: string, backup: string, parent = statSync(dirname(source))): string[] {
  const expected = metadata(backup);
  return [
    restoreHelperPath,
    "--source", source,
    "--backup", backup,
    "--uid", String(expected.uid),
    "--gid", String(expected.gid),
    "--mode", expected.mode.toString(8),
    "--size", String(expected.size),
    "--sha256", expected.sha256,
    "--parent-device", String(parent.dev),
    "--parent-inode", String(parent.ino),
    "--parent-uid", String(parent.uid),
    "--parent-gid", String(parent.gid),
    "--parent-mode", (parent.mode & 0o7777).toString(8),
  ];
}

function runRestore(source: string, backup: string, environment: Record<string, string> = {}, parent = statSync(dirname(source))) {
  return spawnSync("sudo", [
    "-n",
    "env",
    "AGENT_BRIDGE_RESTORE_TEST_MODE=1",
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    ...restoreArguments(source, backup, parent),
  ], { encoding: "utf8" });
}

function rewriteConfig(fixture: Fixture, transform: (lines: string[]) => string[]): void {
  const lines = readFileSync(fixture.configFile, "utf8").trimEnd().split("\n");
  writeFileSync(fixture.configFile, `${transform(lines).join("\n")}\n`, { mode: 0o600 });
}

function writeFakeCommands(fixture: Fixture): void {
  const bin = join(fixture.root, "bin");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "rollout-restore"), `#!/usr/bin/env bash
set -euo pipefail
echo "rollout-restore:$*" >> "${fixture.actionLog}"
if [ "\${FAKE_RESTORE_FAIL:-}" = 1 ]; then
  echo "simulated descriptor-based rollback failure" >&2
  exit 1
fi
exec sudo -n env AGENT_BRIDGE_RESTORE_TEST_MODE=1 "${restoreHelperPath}" "$@"
`);
  executable(join(bin, "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
echo "systemctl:$*" >> "${fixture.actionLog}"
cmd="$1"; shift
case "$cmd" in
  stop)
    count=0
    [ ! -f "${fixture.root}/stop-count" ] || count="$(cat "${fixture.root}/stop-count")"
    count=$((count + 1))
    printf '%s\n' "$count" > "${fixture.root}/stop-count"
    if [ -n "\${FAKE_SYSTEMCTL_STOP_DELAY:-}" ]; then sleep "$FAKE_SYSTEMCTL_STOP_DELAY"; fi
    if [ "\${FAKE_FAIL_PHASE:-}" = stop ] || { [ "$count" -gt 1 ] && [ "\${FAKE_CONTAINMENT_MODE:-}" = active ]; }; then
      printf '%s\n' "\${1:-}" > "${fixture.stateFile}"
    else
      : > "${fixture.stateFile}"
    fi
    if [ "\${FAKE_CONTAINMENT_MODE:-}" = failed-empty-live-cgroup ] || {
      [ "$count" -gt 1 ] && [ "\${FAKE_CONTAINMENT_MODE:-}" = live-cgroup ];
    }; then
      printf '9876\n' > "${fixture.cgroupRoot}/agent-bridge-test/\${1:-unknown}/cgroup.procs"
    fi
    if [ "\${FAKE_CONTAINMENT_MODE:-}" = unreadable-cgroup-procs ]; then
      chmod 000 "${fixture.cgroupRoot}/agent-bridge-test/\${1:-unknown}/cgroup.procs"
    fi
    if [ "\${FAKE_CONTAINMENT_MODE:-}" = unreadable-cgroup-dir ]; then
      chmod 000 "${fixture.cgroupRoot}/agent-bridge-test/\${1:-unknown}"
    fi
    if [ "\${FAKE_CONTAINMENT_MODE:-}" = failed-empty-stop-error ] || {
      [ "$count" -gt 1 ] && [ "\${FAKE_CONTAINMENT_MODE:-}" = stop-error ];
    }; then exit 1; fi
    ;;
  start)
    if [ "\${FAKE_FAIL_PHASE:-}" = start ]; then exit 1; fi
    printf '%s\n' "$@" > "${fixture.stateFile}"
    : > "${fixture.root}/started"
    ;;
  is-active)
    if [ "\${1:-}" = --quiet ]; then shift; fi
    grep -Fxq "\${1:-}" "${fixture.stateFile}"
    ;;
  is-failed) exit 1 ;;
  reset-failed) ;;
  show)
    unit="$1"; shift
    properties=()
    for arg in "$@"; do case "$arg" in --property=*) properties+=("\${arg#--property=}");; esac; done
    for property in "\${properties[@]}"; do
      case "$property" in
        EnvironmentFiles) printf '%s\n%s\n' "${fixture.envDir}/agent-bridge-shared (ignore_errors=yes)" "${fixture.envDir}/\${unit%.service} (ignore_errors=no)" ;;
        Environment) echo NODE_ENV=production ;;
        ActiveState)
          if grep -Fxq "$unit" "${fixture.stateFile}"; then echo active
          elif [[ "\${FAKE_CONTAINMENT_MODE:-}" == *failed-empty* ]]; then echo failed
          else echo inactive
          fi
          ;;
        SubState) grep -Fxq "$unit" "${fixture.stateFile}" && echo running || echo dead ;;
        Result) [[ "\${FAKE_CONTAINMENT_MODE:-}" == *failed-empty* ]] && echo exit-code || echo success ;;
        ExecMainCode) [[ "\${FAKE_CONTAINMENT_MODE:-}" == *failed-empty* ]] && echo exited || echo 0 ;;
        ExecMainStatus) [[ "\${FAKE_CONTAINMENT_MODE:-}" == *failed-empty* ]] && echo 143 || echo 0 ;;
        MainPID) grep -Fxq "$unit" "${fixture.stateFile}" && echo 4242 || echo 0 ;;
        ControlPID) echo 0 ;;
        ControlGroup)
          case "\${FAKE_CONTAINMENT_MODE:-}" in
            empty-controlgroup) echo "" ;;
            missing-cgroup-dir) echo "/agent-bridge-missing/$unit" ;;
            *) echo "/agent-bridge-test/$unit" ;;
          esac
          ;;
        NRestarts)
          if [ "\${FAKE_FAIL_PHASE:-}" = delayed ] && [ -f "${fixture.root}/started" ]; then echo 1; else echo 0; fi
          ;;
        *) exit 2 ;;
      esac
    done
    ;;
  *) exit 2 ;;
esac
`);
  executable(join(bin, "cp"), `#!/usr/bin/env bash
set -euo pipefail
echo "root: backup $*" >> "${fixture.actionLog}"
/usr/bin/cp "$@"
if [ "\${FAKE_FAIL_PHASE:-}" = backup ] && [ ! -e "${fixture.root}/backup-failed" ]; then
  : > "${fixture.root}/backup-failed"
  exit 70
fi
`);
  executable(join(bin, "runuser"), `#!/usr/bin/env bash
set -euo pipefail
echo "runuser:$*" >> "${fixture.actionLog}"
if [ "\${1:-}" = --user ]; then shift 2; fi
if [ "\${1:-}" = -- ]; then shift; fi
phase=""
for arg in "$@"; do case "$arg" in inspect|backup|migrate|validate) phase="$arg";; esac; done
if [ -n "\${FAKE_FAIL_PHASE:-}" ] && [ "\${FAKE_FAIL_PHASE:-}" = "$phase" ]; then
  "$@"
  if [ -n "\${FAKE_CORRUPT_DB:-}" ]; then printf 'corrupt' > "$FAKE_CORRUPT_DB"; fi
  exit 70
fi
exec "$@"
`);
  executable(join(bin, "journalctl"), `#!/usr/bin/env bash
set -euo pipefail
echo "journalctl:$*" >> "${fixture.actionLog}"
if [ -n "\${FAKE_TAMPER_SENTINEL_REPLACE:-}" ]; then
  # mv a freshly created, genuinely distinct-inode decoy file over the
  # sentinel path — rm-then-recreate at the same path risks the filesystem
  # reusing the just-freed inode number, which would defeat the point of
  # this test (proving an identity mismatch is detected).
  decoy="\$(mktemp)"
  printf 'tampered\\n' > "\$decoy"
  chmod 0600 "\$decoy"
  mv -f -- "\$decoy" "\${FAKE_TAMPER_SENTINEL_REPLACE}"
fi
if [ -n "\${FAKE_TAMPER_SENTINEL_DELETE:-}" ]; then
  rm -f -- "\${FAKE_TAMPER_SENTINEL_DELETE}"
fi
if [ "\${FAKE_FAIL_PHASE:-}" = smoke ]; then echo 'simulated startup error'; fi
`);
}

function createFixture(options: { pending?: number; unknownSchema?: boolean; missingDb?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-rollout-"));
  roots.push(root);
  const project = join(root, "project");
  const dbDir = join(root, "databases");
  const backupDir = join(root, "backups");
  const logDir = join(root, "logs");
  const actionLog = join(root, "actions.log");
  const stateFile = join(root, "active-units");
  const lockFile = join(root, "run", "lock", "agent-bridge-rollout.lock");
  const configFile = join(root, "etc", "agent-bridge", "rollout.conf");
  const envDir = join(root, "etc", "default");
  const cgroupRoot = join(root, "sys", "fs", "cgroup");
  mkdirSync(join(project, "scripts"), { recursive: true });
  mkdirSync(join(root, "etc", "agent-bridge"), { recursive: true });
  mkdirSync(envDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  for (const unit of units) {
    const cgroup = join(cgroupRoot, "agent-bridge-test", unit);
    mkdirSync(cgroup, { recursive: true });
    writeFileSync(join(cgroup, "cgroup.procs"), "");
  }
  symlinkSync(sourceDir, join(project, "src"));
  symlinkSync(nodeModules, join(project, "node_modules"));
  if (existsSync(migrationScript)) symlinkSync(migrationScript, join(project, "scripts", "rollout-db.ts"));
  writeFileSync(join(project, "README.md"), "rollout fixture\n");
  execFileSync("git", ["init", "-q", project]);
  execFileSync("git", ["-C", project, "config", "user.email", "rollout@example.invalid"]);
  execFileSync("git", ["-C", project, "config", "user.name", "Rollout Test"]);
  execFileSync("git", ["-C", project, "add", "."]);
  execFileSync("git", ["-C", project, "commit", "-qm", "fixture"]);
  execFileSync("git", ["-C", project, "branch", "-M", "main"]);
  const expectedCommit = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const dbPaths = Array.from({ length: 5 }, (_, index) => join(dbDir, `bridge-${index}.sqlite`));
  for (const [index, path] of dbPaths.entries()) {
    if (options.unknownSchema && index === 0) {
      mkdirSync(dirname(path), { recursive: true });
      const db = new Database(path); db.exec("CREATE TABLE unknown_schema(value TEXT)"); db.close();
    } else if (!(options.missingDb && index === 0)) {
      createLegacyDb(path, index === 0 ? options.pending ?? 0 : 0);
    }
  }

  writeFileSync(join(envDir, "agent-bridge-shared"), `DB_PATH=${dbPaths[0]}\n`, { mode: 0o600 });
  for (const unit of units) {
    const name = unit.replace(/\.service$/, "");
    let content = "";
    if (unit === "agent-bridge-discord-interactive.service") content = `DB_PATH=${dbPaths[1]}\n`;
    if (unit === "agent-bridge-health.service") content = `HEALTH_DB_PATH=${dbPaths[2]}\n`;
    if (unit === "agent-bridge-interactive.service") content = `DB_PATH=${dbPaths[3]}\n`;
    if (unit === "agent-bridge-worker-bot.service") content = `DB_PATH=${dbPaths[4]}\n`;
    writeFileSync(join(envDir, name), content, { mode: 0o600 });
  }

  writeFileSync(configFile, [
    `project_dir=${project}`,
    "runtime_user=rollout-test",
    `node_bin=${process.execPath}`,
    `backup_dir=${backupDir}`,
    `log_dir=${logDir}`,
    ...units.map((unit) => `unit=${unit}`),
    ...dbPaths.map((path) => `database=${path}`),
    "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(stateFile, `${units.join("\n")}\n`);
  writeFileSync(actionLog, "");
  const fixture = { root, project, expectedCommit, dbPaths, actionLog, stateFile, backupDir, logDir, lockFile, configFile, envDir, cgroupRoot };
  writeFakeCommands(fixture);
  return fixture;
}

function runRollout(fixture: Fixture, failPhase?: string, containmentMode?: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
      ...(failPhase ? { FAKE_FAIL_PHASE: failPhase } : {}),
      ...(containmentMode ? { FAKE_CONTAINMENT_MODE: containmentMode } : {}),
      FAKE_CORRUPT_DB: fixture.dbPaths[0],
      ...extraEnv,
    },
  });
}

function useMinimalInventory(fixture: Fixture): Fixture {
  const selectedUnit = units[0];
  rewriteConfig(fixture, (lines) => [
    ...lines.filter((line) => !line.startsWith("unit=") && !line.startsWith("database=")),
    `unit=${selectedUnit}`,
    `database=${fixture.dbPaths[0]}`,
  ]);
  writeFileSync(fixture.stateFile, `${selectedUnit}\n`);
  return fixture;
}

function actions(fixture: Fixture): string {
  return readFileSync(fixture.actionLog, "utf8");
}

async function waitForAction(fixture: Fixture, pattern: RegExp, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(actions(fixture))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${pattern}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("guarded rollout helper", () => {
  it("runs the full fixed-unit rollout sequence and writes durable evidence", () => {
    const fixture = createFixture();
    const result = runRollout(fixture);

    expect(result.status, result.stderr).toBe(0);
    const log = actions(fixture);
    const stopIndex = log.indexOf("systemctl:stop");
    expect(log.slice(0, stopIndex)).toMatch(/\sinspect\s/);
    expect(stopIndex).toBeLessThan(log.indexOf(" backup "));
    expect(log).toMatch(/\sbackup\s/);
    expect(log.indexOf(" backup ")).toBeLessThan(log.indexOf(" migrate "));
    expect(log.indexOf(" migrate ")).toBeLessThan(log.indexOf(" validate "));
    expect(log.indexOf(" validate ")).toBeLessThan(log.indexOf("systemctl:start"));
    expect(log.indexOf("systemctl:start")).toBeLessThan(log.indexOf("journalctl:"));
    expect(readFileSync(fixture.stateFile, "utf8").trim().split("\n")).toEqual(units);
    expect(existsSync(fixture.backupDir)).toBe(true);
    expect(existsSync(fixture.logDir)).toBe(true);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    expect(existsSync(join(artifacts, "backup-manifest.tsv"))).toBe(true);
    expect(existsSync(join(artifacts, "migration-evidence.json"))).toBe(true);
    expect(readFileSync(join(artifacts, "rollout.log"), "utf8")).toContain("rollout completed");
  });

  it("attaches per-database resolving-units evidence, correctly collapsing the shared antigravity/claude/codex unit onto one database", () => {
    // Issue #135 Phase 4C.3: rollout-db.ts inspect gains a resolving-units
    // evidence field, sourced from the same unit->canonical-path resolution
    // rollout-agent-bridge.sh already proves (unit_databases), not
    // re-derived. dbPaths[0] is shared by all three antigravity/claude/codex
    // units in this fixture (see createFixture's env-file wiring above).
    const fixture = createFixture();
    const result = runRollout(fixture);
    expect(result.status, result.stderr).toBe(0);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    const evidence = JSON.parse(readFileSync(join(artifacts, "preflight-evidence.json"), "utf8"));
    const byPath: Record<string, string[]> = Object.fromEntries(
      evidence.databases.map((entry: { path: string; resolvingUnits: string[] }) => [entry.path, [...entry.resolvingUnits].sort()]),
    );
    expect(byPath[fixture.dbPaths[0]]).toEqual([
      "agent-bridge-antigravity.service",
      "agent-bridge-claude.service",
      "agent-bridge-codex.service",
    ]);
    expect(byPath[fixture.dbPaths[1]]).toEqual(["agent-bridge-discord-interactive.service"]);
    expect(byPath[fixture.dbPaths[2]]).toEqual(["agent-bridge-health.service"]);
    expect(byPath[fixture.dbPaths[3]]).toEqual(["agent-bridge-interactive.service"]);
    expect(byPath[fixture.dbPaths[4]]).toEqual(["agent-bridge-worker-bot.service"]);
  });

  it.each([
    ["missing database", { missingDb: true }, /missing database/i],
    ["unknown schema", { unknownSchema: true }, /unknown schema/i],
    ["nonzero legacy queue", { pending: 1 }, /legacy queue/i],
  ] as const)("fails preflight for %s before stopping services", (_name, options, errorPattern) => {
    const fixture = createFixture(options);
    const result = runRollout(fixture);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(errorPattern);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("fails preflight when main is dirty or the expected commit differs", () => {
    const dirty = createFixture();
    writeFileSync(join(dirty.project, "untracked"), "dirty");
    const dirtyResult = runRollout(dirty);
    expect(dirtyResult.status).not.toBe(0);
    expect(`${dirtyResult.stdout}\n${dirtyResult.stderr}`).toMatch(/clean working tree/i);
    expect(actions(dirty)).not.toContain("systemctl:stop");

    const mismatch = createFixture();
    mismatch.expectedCommit = "0".repeat(40);
    const mismatchResult = runRollout(mismatch);
    expect(mismatchResult.status).not.toBe(0);
    expect(`${mismatchResult.stdout}\n${mismatchResult.stderr}`).toMatch(/expected commit/i);
    expect(actions(mismatch)).not.toContain("systemctl:stop");
  });

  it("fails closed when any service remains active after stop", () => {
    const fixture = createFixture();
    const result = runRollout(fixture, "stop");
    expect(result.status).not.toBe(0);
    expect(actions(fixture)).toContain("systemctl:stop");
    expect(actions(fixture)).not.toMatch(/\sbackup\s/);
    expect(actions(fixture)).not.toContain("systemctl:start");
  });

  it("accepts failed/dead exit 143 when stop is nonzero but every cgroup is empty", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, undefined, "failed-empty-stop-error");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    const evidence = JSON.parse(readFileSync(join(artifacts, "containment-evidence.json"), "utf8"));
    expect(evidence.units).toEqual([
      expect.objectContaining({
        unit: units[0],
        ActiveState: "failed",
        SubState: "dead",
        Result: "exit-code",
        ExecMainCode: "exited",
        ExecMainStatus: "143",
        MainPID: 0,
        ControlPID: 0,
        ControlGroup: `/agent-bridge-test/${units[0]}`,
        remainingCgroupPids: [],
      }),
    ]);
    expect(actions(fixture)).toContain(`systemctl:reset-failed ${units[0]}`);
    expect(actions(fixture).indexOf("systemctl:reset-failed")).toBeLessThan(actions(fixture).indexOf("systemctl:start"));
  });

  it("fails closed on a live cgroup member before backup or migration", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, undefined, "failed-empty-live-cgroup");

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/CONTAINMENT INCOMPLETE/);
    expect(actions(fixture)).not.toMatch(/\sbackup\s|\smigrate\s/);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    const evidence = JSON.parse(readFileSync(join(artifacts, "containment-evidence.json"), "utf8"));
    expect(evidence.units[0].remainingCgroupPids).toEqual([9876]);
  });

  it("accepts systemd's affirmative empty ControlGroup report with zero PIDs", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, undefined, "empty-controlgroup");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    const evidence = JSON.parse(readFileSync(join(artifacts, "containment-evidence.json"), "utf8"));
    expect(evidence.units[0]).toEqual(expect.objectContaining({
      ControlGroup: "",
      MainPID: 0,
      ControlPID: 0,
      remainingCgroupPids: [],
    }));
  });

  it.each([
    "missing-cgroup-dir",
    "unreadable-cgroup-dir",
    "unreadable-cgroup-procs",
  ])("fails closed before backup or migration when the cgroup cannot be inspected: %s", (mode) => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    try {
      const result = runRollout(fixture, undefined, mode);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/CONTAINMENT INCOMPLETE/);
      expect(actions(fixture)).not.toMatch(/\sbackup\s|\smigrate\s/);
      expect(fixture.dbPaths.map(sha256)).toEqual(before);
    } finally {
      for (const unit of units) {
        const cgroup = join(fixture.cgroupRoot, "agent-bridge-test", unit);
        try {
          chmodSync(cgroup, 0o755);
          chmodSync(join(cgroup, "cgroup.procs"), 0o644);
        } catch {}
      }
    }
  });

  it.runIf(process.env.AGENT_BRIDGE_REAL_SYSTEMD_TEST === "1")(
    "accepts a real failed/dead user service that exits 143 with an empty cgroup",
    async () => {
      const fixture = useMinimalInventory(createFixture());
      const unit = units[0];
      const runtimeDir = `/run/user/${process.getuid()}`;
      const userEnv = {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDir,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
      };
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

      try {
        execFileSync("systemd-run", [
          "--user",
          `--unit=${unit}`,
          "--service-type=simple",
          "--property=Restart=no",
          "/bin/sh",
          "-c",
          "trap 'exit 143' TERM; while :; do sleep 1; done",
        ], { env: userEnv, stdio: "ignore" });
        const deadline = Date.now() + 5_000;
        while (execFileSync("systemctl", ["--user", "show", unit, "-p", "ActiveState", "--value"], { env: userEnv, encoding: "utf8" }).trim() !== "active") {
          if (Date.now() >= deadline) throw new Error("real systemd fixture did not become active");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        const result = runRollout(fixture, "backup");
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain("all selected services verified stopped");
        expect(`${result.stdout}\n${result.stderr}`).not.toContain("CONTAINMENT INCOMPLETE");
        const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
        const evidence = JSON.parse(readFileSync(join(artifacts, "containment-evidence.json"), "utf8"));
        expect(evidence.units[0]).toEqual(expect.objectContaining({
          unit,
          ActiveState: "failed",
          SubState: "failed",
          ExecMainStatus: "143",
          MainPID: 0,
          ControlPID: 0,
          remainingCgroupPids: [],
        }));
      } finally {
        spawnSync("systemctl", ["--user", "stop", unit], { env: userEnv, stdio: "ignore" });
        spawnSync("systemctl", ["--user", "reset-failed", unit], { env: userEnv, stdio: "ignore" });
      }
    },
    15_000,
  );

  it.each(["backup", "migrate", "validate"])("restores every database after a pre-start %s failure", (phase) => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, phase);
    expect(result.status).not.toBe(0);
    expect(fixture.dbPaths.map(sha256)).toEqual(before);
    expect(actions(fixture)).not.toContain("systemctl:start");
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  });

  it("restores byte content and original ownership, mode, and size", () => {
    const fixture = useMinimalInventory(createFixture());
    chmodSync(fixture.dbPaths[0], 0o640);
    const before = metadata(fixture.dbPaths[0]);

    const result = runRollout(fixture, "migrate");

    expect(result.status).not.toBe(0);
    expect(metadata(fixture.dbPaths[0])).toEqual(before);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    expect(readFileSync(join(artifacts, "backup-manifest.tsv"), "utf8")).toContain("uid\tgid\tmode\tsize");
    expect(readFileSync(join(artifacts, "backup-manifest.tsv"), "utf8")).toContain("parent_device\tparent_inode\tparent_uid\tparent_gid\tparent_mode");
  });

  it("does not follow a planted predictable restore symlink", () => {
    const fixture = useMinimalInventory(createFixture());
    const victim = join(fixture.root, "root-owned-victim");
    writeFileSync(victim, "do-not-touch", { mode: 0o600 });
    symlinkSync(victim, `${fixture.dbPaths[0]}.rollout-restore`);
    const victimBefore = metadata(victim);
    const databaseBefore = metadata(fixture.dbPaths[0]);

    const result = runRollout(fixture, "migrate");

    expect(result.status).not.toBe(0);
    expect(metadata(victim)).toEqual(victimBefore);
    expect(metadata(fixture.dbPaths[0])).toEqual(databaseBefore);
    expect(lstatSync(`${fixture.dbPaths[0]}.rollout-restore`).isSymbolicLink()).toBe(true);
  });

  it("rejects active substitution of the generated restore file without modifying the victim", () => {
    const fixture = createFixture();
    const source = fixture.dbPaths[0];
    const backup = join(fixture.root, "restore-source.sqlite");
    const victim = join(fixture.root, "root-owned-victim");
    writeFileSync(backup, readFileSync(source), { mode: 0o640 });
    writeFileSync(source, "mutated-database", { mode: 0o640 });
    writeFileSync(victim, "do-not-touch", { mode: 0o600 });
    const victimBefore = metadata(victim);

    const result = runRestore(source, backup, {
      AGENT_BRIDGE_RESTORE_TEST_SWAP_TARGET: victim,
      AGENT_BRIDGE_RESTORE_TEST_SWAP_STAGE: "after-create",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/active substitution detected/i);
    expect(metadata(victim)).toEqual(victimBefore);
    expect(readFileSync(source, "utf8")).toBe("mutated-database");
  });

  it("rejects a source parent replaced by a symlink before descriptor open", () => {
    const fixture = createFixture();
    const source = fixture.dbPaths[0];
    const sourceParent = dirname(source);
    const expectedParent = statSync(sourceParent);
    const backup = join(fixture.root, "parent-symlink-backup.sqlite");
    writeFileSync(backup, readFileSync(source), { mode: 0o640 });
    const originalParent = `${sourceParent}-original`;
    const attackerParent = join(fixture.root, "attacker-parent");
    renameSync(sourceParent, originalParent);
    mkdirSync(attackerParent);
    const victim = join(attackerParent, basename(source));
    writeFileSync(victim, "do-not-touch", { mode: 0o640 });
    const victimBefore = metadata(victim);
    symlinkSync(attackerParent, sourceParent, "dir");

    const result = runRestore(source, backup, {}, expectedParent);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/source parent must not be a symlink/i);
    expect(metadata(victim)).toEqual(victimBefore);
  });

  it("rejects a source parent replaced by a different directory inode", () => {
    const fixture = createFixture();
    const source = fixture.dbPaths[0];
    const sourceParent = dirname(source);
    const expectedParent = statSync(sourceParent);
    const backup = join(fixture.root, "parent-inode-backup.sqlite");
    writeFileSync(backup, readFileSync(source), { mode: 0o640 });
    renameSync(sourceParent, `${sourceParent}-original`);
    mkdirSync(sourceParent);
    writeFileSync(source, "do-not-touch", { mode: 0o640 });
    const victimBefore = metadata(source);

    const result = runRestore(source, backup, {}, expectedParent);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/parent directory identity mismatch/i);
    expect(metadata(source)).toEqual(victimBefore);
  });

  it("blocks runtime-user restore-entry replacement after inode verification", () => {
    const fixture = createFixture();
    const source = fixture.dbPaths[0];
    const backup = join(fixture.root, "blocked-substitution-backup.sqlite");
    const victim = join(fixture.root, "blocked-substitution-victim");
    writeFileSync(backup, readFileSync(source), { mode: 0o640 });
    writeFileSync(source, "mutated-database", { mode: 0o640 });
    writeFileSync(victim, "do-not-touch", { mode: 0o600 });
    const victimBefore = metadata(victim);

    const result = runRestore(source, backup, {
      AGENT_BRIDGE_RESTORE_TEST_SWAP_TARGET: victim,
      AGENT_BRIDGE_RESTORE_TEST_SWAP_STAGE: "after-inode-check",
      AGENT_BRIDGE_RESTORE_TEST_ATTACKER_UID: String(process.getuid()),
      AGENT_BRIDGE_RESTORE_TEST_ATTACKER_GID: String(process.getgid()),
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(source)).toEqual(readFileSync(backup));
    expect(metadata(victim)).toEqual(victimBefore);
  });

  it("restores the exact parent mode after failure inside the write-disabled section", () => {
    const fixture = createFixture();
    const source = fixture.dbPaths[0];
    const sourceParent = dirname(source);
    chmodSync(sourceParent, 0o775);
    const expectedMode = statSync(sourceParent).mode & 0o7777;
    const backup = join(fixture.root, "critical-failure-backup.sqlite");
    writeFileSync(backup, readFileSync(source), { mode: 0o640 });

    const result = runRestore(source, backup, { AGENT_BRIDGE_RESTORE_TEST_FAIL_STAGE: "after-write-disable" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/injected failure/i);
    expect(statSync(sourceParent).mode & 0o7777).toBe(expectedMode);
  });

  it("fails when the final destination is not the restored descriptor inode", () => {
    const fixture = createFixture();
    const source = fixture.dbPaths[0];
    const backup = join(fixture.root, "final-inode-backup.sqlite");
    const victim = join(fixture.root, "final-inode-victim");
    writeFileSync(backup, readFileSync(source), { mode: 0o640 });
    writeFileSync(source, "mutated-database", { mode: 0o640 });
    writeFileSync(victim, "do-not-touch", { mode: 0o600 });
    const victimBefore = metadata(victim);

    const result = runRestore(source, backup, {
      AGENT_BRIDGE_RESTORE_TEST_FINAL_TARGET: victim,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/final destination inode mismatch/i);
    expect(metadata(victim)).toEqual(victimBefore);
  });

  it("supports a fixed selected-unit subset and de-duplicates shared databases", () => {
    const fixture = createFixture();
    const selected = ["agent-bridge-antigravity.service", "agent-bridge-codex.service"];
    rewriteConfig(fixture, (lines) => [
      ...lines.filter((line) => !line.startsWith("unit=") && !line.startsWith("database=")),
      ...selected.map((unit) => `unit=${unit}`),
      `database=${fixture.dbPaths[0]}`,
    ]);
    writeFileSync(fixture.stateFile, `${selected.join("\n")}\n`);

    const result = runRollout(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(fixture.stateFile, "utf8").trim().split("\n")).toEqual(selected);
  });

  it.each([
    ["missing allowlist database", (fixture: Fixture) => rewriteConfig(fixture, (lines) => lines.filter((line) => line !== `database=${fixture.dbPaths[4]}`))],
    ["extra allowlist database", (fixture: Fixture) => {
      const extra = join(fixture.root, "databases", "extra.sqlite");
      createLegacyDb(extra);
      rewriteConfig(fixture, (lines) => [...lines, `database=${extra}`]);
    }],
    ["duplicate allowlist database", (fixture: Fixture) => rewriteConfig(fixture, (lines) => [...lines, `database=${fixture.dbPaths[0]}`])],
    ["mismatched unit database", (fixture: Fixture) => writeFileSync(join(fixture.envDir, "agent-bridge-worker-bot"), `DB_PATH=${fixture.dbPaths[3]}\n`, { mode: 0o600 })],
    ["defaulted unit database", (fixture: Fixture) => {
      writeFileSync(join(fixture.envDir, "agent-bridge-shared"), "", { mode: 0o600 });
      writeFileSync(join(fixture.envDir, "agent-bridge-codex"), "", { mode: 0o600 });
    }],
  ] as const)("aborts before stop for %s", (_name, mutate) => {
    const fixture = createFixture();
    mutate(fixture);
    const result = runRollout(fixture);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/database|inventory|duplicate|default/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("runs every Git inspection through the runtime user", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture);
    expect(result.status, result.stderr).toBe(0);
    const gitChecks = actions(fixture).split("\n").filter((line) => line.includes(" /usr/bin/git "));
    expect(gitChecks.length).toBeGreaterThanOrEqual(6);
    expect(gitChecks.every((line) => line.startsWith("runuser:"))).toBe(true);
  });

  it("rejects symlinked or writable evidence roots before stopping services", () => {
    const fixture = createFixture();
    rmSync(fixture.logDir, { recursive: true });
    const target = join(fixture.root, "attacker-log-target");
    mkdirSync(target, { mode: 0o777 });
    symlinkSync(target, fixture.logDir);
    const result = runRollout(fixture);
    expect(result.status).not.toBe(0);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it.each(["start", "smoke"])("stops services and preserves migrated evidence after a post-start %s failure", (phase) => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, phase);
    expect(result.status).not.toBe(0);
    expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
    expect(actions(fixture).match(/systemctl:stop/g)?.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  });

  it("contains all services when one crashes during the smoke window", () => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, "delayed");
    expect(result.status).not.toBe(0);
    expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
    expect(actions(fixture).match(/systemctl:stop/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it.each(["live-cgroup", "active"])("skips pre-start rollback when containment is incomplete: %s", (mode) => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, "migrate", mode);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/CONTAINMENT INCOMPLETE/);
    expect(output).toMatch(/rollback skipped/i);
    expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
    expect(output).not.toContain("services remain stopped");
  });

  it("preserves migrated evidence when post-start containment cannot be proven", () => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, "smoke", "live-cgroup");
    const output = `${result.stdout}\n${result.stderr}`;
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/CONTAINMENT INCOMPLETE/);
    expect(output).not.toContain("services remain stopped");
    expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
    expect(existsSync(join(artifacts, "migration-evidence.json"))).toBe(true);
  });

  it("rejects a concurrent rollout through the exclusive OS lock", async () => {
    const fixture = createFixture();
    const first: ChildProcess = spawn("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
      env: {
        ...process.env,
        AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
        FAKE_SYSTEMCTL_STOP_DELAY: "0.5",
        FAKE_FAIL_PHASE: "stop",
      },
      stdio: "ignore",
    });
    await waitForAction(fixture, /systemctl:stop/);
    const second = runRollout(fixture);
    expect(second.status).not.toBe(0);
    await new Promise<void>((resolve) => first.once("close", () => resolve()));
  });

  it("keeps the legacy restart helper unchanged", () => {
    const restart = readFileSync(fileURLToPath(new URL("../scripts/restart-agent-bridge.sh", import.meta.url)), "utf8");
    expect(restart).toContain('systemctl restart "${units[@]}"');
    expect(restart).not.toContain("rollout-db");
  });
});

describe("interrupted-rollout sentinel (Phase 4C.4, issue #135)", () => {
  function sentinelPath(fixture: Fixture): string {
    return join(fixture.logDir, ".rollout-in-progress");
  }

  function runSentinelClear(fixture: Fixture, expectedCommit: string, artifactDir: string, env: Record<string, string> = {}) {
    return spawnSync("bash", [sentinelClearPath, "--expected-commit", expectedCommit, "--artifact-dir", artifactDir], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root, ...env },
    });
  }

  it("creates the sentinel immediately and removes it on a fully successful rollout", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(sentinelPath(fixture)), "sentinel must be removed after a DONE outcome").toBe(false);
  });

  it("fails an otherwise-successful rollout, never claiming success, when its own sentinel is replaced before cleanup", () => {
    // Cleanup must be fail-closed: if the sentinel this invocation created
    // is swapped for a different file at the same path before on_exit runs
    // (identity mismatch — different inode), the rollout must not exit 0 or
    // print a false "removed" claim, even though every rollout phase itself
    // succeeded.
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, undefined, undefined, { FAKE_TAMPER_SENTINEL_REPLACE: sentinelPath(fixture) });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/SENTINEL CLEANUP FAILED/i);
    expect(output).not.toMatch(/rollout sentinel removed/);
    expect(readFileSync(sentinelPath(fixture), "utf8")).toBe("tampered\n");
  });

  it("fails an otherwise-successful rollout, never claiming success, when its own sentinel unexpectedly disappears before cleanup", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, undefined, undefined, { FAKE_TAMPER_SENTINEL_DELETE: sentinelPath(fixture) });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/SENTINEL CLEANUP FAILED/i);
    expect(output).toMatch(/unexpectedly missing/i);
    expect(output).not.toMatch(/rollout sentinel removed/);
  });

  it("removes the sentinel after a pure precondition failure (bare re-invocation behaves identically to the first attempt)", () => {
    const dirty = useMinimalInventory(createFixture());
    writeFileSync(join(dirty.project, "untracked"), "dirty");
    const result = runRollout(dirty);
    expect(result.status).not.toBe(0);
    expect(actions(dirty)).not.toContain("systemctl:stop");
    expect(existsSync(sentinelPath(dirty)), "sentinel must be removed after a precondition failure — nothing was ever touched").toBe(false);
  });

  it("retains the sentinel and reports STOPPED_UNCHANGED when the cohort backup does not complete, even though a partial backup artifact exists", () => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, "backup");
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/STATE: STOPPED_UNCHANGED/);
    expect(output).not.toMatch(/RESTORE_INCOMPLETE|FAILED_RESTORED/);
    expect(fixture.dbPaths.map(sha256)).toEqual(before);
    expect(existsSync(sentinelPath(fixture)), "sentinel must be retained — services are down and assert_service_active would reject a bare retry").toBe(true);

    // backup_completed=0 means backup_databases() did not finish and verify
    // the whole cohort — it does NOT mean nothing was ever written to disk.
    // The fake `cp` genuinely copies the source before the forced failure,
    // so a real, unmanifested backup file exists here. STOPPED_UNCHANGED
    // must not claim otherwise, and must warn it's unsafe to restore from.
    const backupSetDirs = readdirSync(fixture.backupDir);
    expect(backupSetDirs.length, "a partial backup set directory is expected even though the cohort backup did not complete").toBe(1);
    const partialBackupFile = join(fixture.backupDir, backupSetDirs[0], `01-${basename(fixture.dbPaths[0])}`);
    expect(existsSync(partialBackupFile), "a partial, unmanifested backup artifact must exist and must never be treated as a valid cohort backup").toBe(true);
    expect(output).toMatch(/partial backup artifacts may exist.*must not be used for restore/i);
  });

  it("retains the sentinel and reports RESTORE_INCOMPLETE when the automatic restore itself fails", () => {
    const fixture = useMinimalInventory(createFixture());
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
    expect(output).not.toMatch(/FAILED_RESTORED|STOPPED_UNCHANGED/);
    expect(existsSync(sentinelPath(fixture)), "sentinel must be retained — the database state is unverified, not safely known").toBe(true);
  });

  it("removes the sentinel and reports FAILED_RESTORED when migration fails but the automatic restore succeeds and is verified", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, "migrate");
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/STATE: FAILED_RESTORED/);
    expect(output).not.toMatch(/RESTORE_INCOMPLETE|STOPPED_UNCHANGED/);
    expect(existsSync(sentinelPath(fixture)), "sentinel is removed once restoration is verified — but this only means 'safe to hand to the documented recovery flow,' not 'safe to bare-retry'").toBe(false);
  });

  it("retains the sentinel and reports STOPPED_PRESERVED after a post-start failure (database already on the new schema)", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, "start");
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/STATE: STOPPED_PRESERVED/);
    expect(existsSync(sentinelPath(fixture)), "sentinel must be retained — always requires operator review, never an automatic retry").toBe(true);
  });

  it("blocks a second invocation while a sentinel from an interrupted run is present, citing its recorded evidence", () => {
    const fixture = useMinimalInventory(createFixture());
    const failed = runRollout(fixture, "backup");
    expect(failed.status).not.toBe(0);
    expect(existsSync(sentinelPath(fixture))).toBe(true);
    const stopCountAfterFirstRun = actions(fixture).match(/systemctl:stop/g)?.length ?? 0;

    const second = runRollout(fixture);
    const output = `${second.stdout}\n${second.stderr}`;
    expect(second.status).not.toBe(0);
    expect(output).toMatch(/interrupted rollout sentinel already exists/i);
    expect(output).toContain(fixture.expectedCommit);
    // The second invocation must never have reached the stop phase — the
    // sentinel check happens before any precondition check. So the stop
    // count must be identical to what the first (failed) run alone produced.
    expect(actions(fixture).match(/systemctl:stop/g)?.length).toBe(stopCountAfterFirstRun);
  });

  it("auto-removes the sentinel it just created when a pre-existing artifact directory blocks the same invocation (the cleanup trap must already be active at that point)", () => {
    // Regression for the exact same-second reproduction the sentinel work
    // was built to fix: this invocation creates its own sentinel, then dies
    // on the pre-existing artifact_dir collision below — a precondition-type
    // failure (stop was never attempted) that must auto-remove the sentinel
    // it just created. A pinned timestamp (test-only seam) makes the
    // collision deterministic instead of racing the wall clock.
    const fixture = useMinimalInventory(createFixture());
    const timestamp = "20260101T000000Z";
    const artifactDir = join(fixture.logDir, `${timestamp}-${fixture.expectedCommit}`);
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });

    const result = runRollout(fixture, undefined, undefined, { AGENT_BRIDGE_ROLLOUT_TEST_TIMESTAMP: timestamp });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/rollout artifact directory already exists/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(existsSync(sentinelPath(fixture)), "sentinel created by this invocation must be auto-removed — the cleanup trap must be active before the artifact_dir collision check runs, not just before sentinel creation").toBe(false);
  });

  it("auto-removes the sentinel it just created when artifact/log setup fails after sentinel publication but before any service is touched", () => {
    // A second, independent gap: a failure in the artifact/log setup phase
    // (writing $log_dir/latest) that happens strictly after the sentinel is
    // published but strictly before git/service preconditions run. The
    // cleanup trap must already be active for this failure too.
    const fixture = useMinimalInventory(createFixture());
    mkdirSync(join(fixture.logDir, "latest"));

    const result = runRollout(fixture);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(existsSync(sentinelPath(fixture)), "sentinel created by this invocation must be auto-removed after an artifact/log setup failure").toBe(false);
  });

  it("refuses to trust a sentinel that is a symlink, never following it", () => {
    const fixture = useMinimalInventory(createFixture());
    symlinkSync("/etc/passwd", sentinelPath(fixture));
    const result = runRollout(fixture);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/sentinel is a symlink/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(lstatSync(sentinelPath(fixture)).isSymbolicLink()).toBe(true);
  });

  it("refuses to trust a sentinel with unsafe permissions", () => {
    const fixture = useMinimalInventory(createFixture());
    writeFileSync(sentinelPath(fixture), "expected_commit=0\nartifact_dir=/tmp\n");
    chmodSync(sentinelPath(fixture), 0o644);
    const result = runRollout(fixture);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/unsafe ownership or mode/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  describe("rollout-sentinel-clear.sh", () => {
    it("is executable", () => {
      execFileSync("test", ["-x", sentinelClearPath]);
    });

    it("clears a valid sentinel whose recorded values match the operator-supplied confirmation", () => {
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
      const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1];
      expect(recordedArtifactDir).toBeTruthy();

      const clear = runSentinelClear(fixture, fixture.expectedCommit, recordedArtifactDir!);
      expect(clear.status, `${clear.stdout}\n${clear.stderr}`).toBe(0);
      expect(existsSync(sentinelPath(fixture))).toBe(false);
      expect(readFileSync(join(fixture.logDir, "sentinel-clear.log"), "utf8")).toContain(fixture.expectedCommit);

      // A fresh rollout can now proceed — precondition checks no longer see
      // a sentinel in the way. Force the retry into a new wall-clock second
      // so its artifact_dir (timestamp-derived) can't collide with the one
      // the failed run already created on disk — an orthogonal, pre-existing
      // timestamp-resolution property of artifact_dir naming, not something
      // the sentinel is meant to guard against.
      execFileSync("sleep", ["1"]);
      writeFileSync(fixture.stateFile, `${units[0]}\n`); // restore active-unit baseline the failed run tore down
      const retry = runRollout(fixture);
      expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    }, 15_000);

    it("refuses when the recorded expected_commit does not match the operator-supplied value", () => {
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
      const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;

      const clear = runSentinelClear(fixture, "1".repeat(40), recordedArtifactDir);
      expect(clear.status).not.toBe(0);
      expect(clear.stderr).toMatch(/does not match the sentinel's recorded value/i);
      expect(existsSync(sentinelPath(fixture)), "sentinel must remain untouched on a mismatch").toBe(true);
    });

    it("refuses when the recorded artifact_dir does not match the operator-supplied value", () => {
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);

      const clear = runSentinelClear(fixture, fixture.expectedCommit, "/tmp/wrong-artifact-dir");
      expect(clear.status).not.toBe(0);
      expect(clear.stderr).toMatch(/does not match the sentinel's recorded value/i);
      expect(existsSync(sentinelPath(fixture)), "sentinel must remain untouched on a mismatch").toBe(true);
    });

    it("is a no-op when no sentinel is present", () => {
      const fixture = useMinimalInventory(createFixture());
      const clear = runSentinelClear(fixture, "0".repeat(40), "/tmp/nonexistent");
      expect(clear.status, `${clear.stdout}\n${clear.stderr}`).toBe(0);
      expect(clear.stdout).toMatch(/nothing to clear/i);
    });

    it("refuses to acquire the lock — and leaves the sentinel completely untouched — while a rollout is actively running", async () => {
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const before = readFileSync(sentinelPath(fixture), "utf8");

      // Restore the active-unit baseline so a second rollout can pass its
      // own preconditions far enough to hold the lock for a while — but it
      // will immediately hit the pre-existing sentinel and hang there only
      // as long as it takes to fail; to hold the lock deliberately, acquire
      // it directly instead of racing a real rollout invocation.
      const holder: ChildProcess = spawn("bash", ["-c", `exec 9>"${fixture.lockFile}"; flock --exclusive 9; sleep 5`]);
      try {
        const deadline = Date.now() + 2_000;
        let locked = false;
        while (Date.now() < deadline) {
          const probe = spawnSync("bash", ["-c", `exec 9>"${fixture.lockFile}"; flock --exclusive --nonblock 9 && flock --unlock 9`]);
          if (probe.status !== 0) { locked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(locked, "lock holder never acquired the lock").toBe(true);

        const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
        const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;
        const clear = runSentinelClear(fixture, fixture.expectedCommit, recordedArtifactDir);
        expect(clear.status).not.toBe(0);
        expect(clear.stderr).toMatch(/a rollout is currently active/i);
      } finally {
        holder.kill();
      }
      expect(readFileSync(sentinelPath(fixture), "utf8")).toBe(before);
    });

    it("refuses to write through a symlinked sentinel-clear audit log, leaving the decoy target and the sentinel untouched", () => {
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
      const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;

      const decoy = join(fixture.root, "decoy-target");
      writeFileSync(decoy, "do-not-touch\n");
      symlinkSync(decoy, join(fixture.logDir, "sentinel-clear.log"));

      const clear = runSentinelClear(fixture, fixture.expectedCommit, recordedArtifactDir);
      const output = `${clear.stdout}\n${clear.stderr}`;
      expect(clear.status, output).not.toBe(0);
      expect(output).toMatch(/audit log is a symlink/i);
      expect(readFileSync(decoy, "utf8")).toBe("do-not-touch\n");
      expect(existsSync(sentinelPath(fixture)), "sentinel must remain — the clear tool must refuse before ever touching it").toBe(true);
    });

    it("never records a false 'cleared' completion entry when sentinel removal itself fails, and leaves the sentinel in place", () => {
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
      const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;

      const clear = runSentinelClear(fixture, fixture.expectedCommit, recordedArtifactDir, {
        AGENT_BRIDGE_ROLLOUT_TEST_FORCE_SENTINEL_RM_FAILURE: "1",
      });
      const output = `${clear.stdout}\n${clear.stderr}`;
      expect(clear.status, output).not.toBe(0);
      expect(output).not.toMatch(/sentinel cleared/i);
      expect(existsSync(sentinelPath(fixture)), "sentinel must remain in place when removal fails").toBe(true);
      const auditContent = readFileSync(join(fixture.logDir, "sentinel-clear.log"), "utf8");
      expect(auditContent).toMatch(/action=clear_attempt/);
      expect(auditContent).not.toMatch(/action=clear_completed/);
    });
  });
});
