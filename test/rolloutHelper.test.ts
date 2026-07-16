import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const helperPath = fileURLToPath(new URL("../scripts/rollout-agent-bridge.sh", import.meta.url));
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

function writeFakeCommands(fixture: Fixture): void {
  const bin = join(fixture.root, "bin");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
echo "systemctl:$*" >> "${fixture.actionLog}"
cmd="$1"; shift
case "$cmd" in
  stop)
    if [ -n "\${FAKE_SYSTEMCTL_STOP_DELAY:-}" ]; then sleep "$FAKE_SYSTEMCTL_STOP_DELAY"; fi
    if [ "\${FAKE_FAIL_PHASE:-}" = stop ]; then printf '%s\n' "\${1:-}" > "${fixture.stateFile}"; else : > "${fixture.stateFile}"; fi
    ;;
  start)
    if [ "\${FAKE_FAIL_PHASE:-}" = start ]; then exit 1; fi
    printf '%s\n' "$@" > "${fixture.stateFile}"
    ;;
  is-active)
    if [ "\${1:-}" = --quiet ]; then shift; fi
    grep -Fxq "\${1:-}" "${fixture.stateFile}"
    ;;
  *) exit 2 ;;
esac
`);
  executable(join(bin, "runuser"), `#!/usr/bin/env bash
set -euo pipefail
echo "runuser:$*" >> "${fixture.actionLog}"
if [ "\${1:-}" = --user ]; then shift 2; fi
if [ "\${1:-}" = -- ]; then shift; fi
phase=""
for arg in "$@"; do case "$arg" in inspect|backup|migrate|validate) phase="$arg";; esac; done
if [ "\${FAKE_FAIL_PHASE:-}" = "$phase" ]; then
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
  mkdirSync(join(project, "scripts"), { recursive: true });
  mkdirSync(join(root, "etc", "agent-bridge"), { recursive: true });
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

  writeFileSync(join(root, "etc", "agent-bridge", "rollout.conf"), [
    `project_dir=${project}`,
    "runtime_user=rollout-test",
    `node_bin=${process.execPath}`,
    `backup_dir=${backupDir}`,
    `log_dir=${logDir}`,
    ...dbPaths.map((path) => `database=${path}`),
    "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(stateFile, `${units.join("\n")}\n`);
  writeFileSync(actionLog, "");
  const fixture = { root, project, expectedCommit, dbPaths, actionLog, stateFile, backupDir, logDir, lockFile };
  writeFakeCommands(fixture);
  return fixture;
}

function runRollout(fixture: Fixture, failPhase?: string) {
  return spawnSync("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
      ...(failPhase ? { FAKE_FAIL_PHASE: failPhase } : {}),
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
    expect(log.indexOf("systemctl:stop")).toBeLessThan(log.indexOf("runuser:--user rollout-test --"));
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

  it.each(["start", "smoke"])("stops services and preserves migrated evidence after a post-start %s failure", (phase) => {
    const fixture = createFixture();
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, phase);
    expect(result.status).not.toBe(0);
    expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
    expect(actions(fixture).match(/systemctl:stop/g)?.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
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
