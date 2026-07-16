import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const helperPath = fileURLToPath(new URL("../scripts/rollout-agent-bridge.sh", import.meta.url));
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

function rewriteConfig(fixture: Fixture, transform: (lines: string[]) => string[]): void {
  const lines = readFileSync(fixture.configFile, "utf8").trimEnd().split("\n");
  writeFileSync(fixture.configFile, `${transform(lines).join("\n")}\n`, { mode: 0o600 });
}

function writeFakeCommands(fixture: Fixture): void {
  const bin = join(fixture.root, "bin");
  mkdirSync(bin, { recursive: true });
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
    if [ "$count" -gt 1 ] && [ "\${FAKE_CONTAINMENT_MODE:-}" = stop-error ]; then exit 1; fi
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
  show)
    unit="$1"; shift
    property=""
    for arg in "$@"; do case "$arg" in --property=*) property="\${arg#--property=}";; esac; done
    case "$property" in
      EnvironmentFiles) printf '%s\n%s\n' "${fixture.envDir}/agent-bridge-shared (ignore_errors=yes)" "${fixture.envDir}/\${unit%.service} (ignore_errors=no)" ;;
      Environment) echo NODE_ENV=production ;;
      ActiveState) grep -Fxq "$unit" "${fixture.stateFile}" && echo active || echo inactive ;;
      SubState) grep -Fxq "$unit" "${fixture.stateFile}" && echo running || echo dead ;;
      MainPID) grep -Fxq "$unit" "${fixture.stateFile}" && echo 4242 || echo 0 ;;
      ControlPID) echo 0 ;;
      NRestarts)
        if [ "\${FAKE_FAIL_PHASE:-}" = delayed ] && [ -f "${fixture.root}/started" ]; then echo 1; else echo 0; fi
        ;;
      *) exit 2 ;;
    esac
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
  mkdirSync(join(project, "scripts"), { recursive: true });
  mkdirSync(join(root, "etc", "agent-bridge"), { recursive: true });
  mkdirSync(envDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
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
  const fixture = { root, project, expectedCommit, dbPaths, actionLog, stateFile, backupDir, logDir, lockFile, configFile, envDir };
  writeFakeCommands(fixture);
  return fixture;
}

function runRollout(fixture: Fixture, failPhase?: string, containmentMode?: string) {
  return spawnSync("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
      ...(failPhase ? { FAKE_FAIL_PHASE: failPhase } : {}),
      ...(containmentMode ? { FAKE_CONTAINMENT_MODE: containmentMode } : {}),
      FAKE_CORRUPT_DB: fixture.dbPaths[0],
    },
  });
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

  it.each(["backup", "migrate", "validate"])("restores every database after a pre-start %s failure", (phase) => {
    const fixture = createFixture();
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, phase);
    expect(result.status).not.toBe(0);
    expect(fixture.dbPaths.map(sha256)).toEqual(before);
    expect(actions(fixture)).not.toContain("systemctl:start");
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  });

  it("restores byte content and original ownership, mode, and size", () => {
    const fixture = createFixture();
    chmodSync(fixture.dbPaths[0], 0o640);
    const before = metadata(fixture.dbPaths[0]);

    const result = runRollout(fixture, "migrate");

    expect(result.status).not.toBe(0);
    expect(metadata(fixture.dbPaths[0])).toEqual(before);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    expect(readFileSync(join(artifacts, "backup-manifest.tsv"), "utf8")).toContain("uid\tgid\tmode\tsize");
  });

  it("does not follow a planted predictable restore symlink", () => {
    const fixture = createFixture();
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
    const expected = metadata(backup);
    const victimBefore = metadata(victim);

    const result = spawnSync("python3", [
      restoreHelperPath,
      "--source", source,
      "--backup", backup,
      "--uid", String(expected.uid),
      "--gid", String(expected.gid),
      "--mode", expected.mode.toString(8),
      "--size", String(expected.size),
      "--sha256", expected.sha256,
    ], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_RESTORE_TEST_SWAP_TARGET: victim },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/active substitution detected/i);
    expect(metadata(victim)).toEqual(victimBefore);
    expect(readFileSync(source, "utf8")).toBe("mutated-database");
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
    const fixture = createFixture();
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
    const fixture = createFixture();
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, phase);
    expect(result.status).not.toBe(0);
    expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
    expect(actions(fixture).match(/systemctl:stop/g)?.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  });

  it("contains all services when one crashes during the smoke window", () => {
    const fixture = createFixture();
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, "delayed");
    expect(result.status).not.toBe(0);
    expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
    expect(actions(fixture).match(/systemctl:stop/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it.each(["stop-error", "active"])("skips pre-start rollback when containment is incomplete: %s", (mode) => {
    const fixture = createFixture();
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
    const fixture = createFixture();
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, "smoke", "stop-error");
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
        FAKE_SYSTEMCTL_STOP_DELAY: "1",
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
