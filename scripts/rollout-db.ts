/**
 * PURPOSE: Inspect, migrate, and validate the root-resolved SQLite inventory used by guarded production rollouts.
 * INPUTS: A rollout phase, evidence path, and an explicit list of existing SQLite database files.
 * OUTPUTS: Metadata-only schema, integrity, queue, and hash evidence.
 * NEIGHBORS: scripts/rollout-agent-bridge.sh, src/db.ts
 * LOGIC: Rejects unknown schemas before mutation, runs existing openDb migrations, and validates the exact current lane/queue columns.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";

/** The five canonical database roles (policy doc §4) — structural validity only; the actual role/path allowlist lives in the root-owned bootstrap config, outside this script's scope. */
const VALID_ROLES = new Set(["shared", "discord", "health", "interactive", "worker"]);

type Mode = "inspect" | "migrate" | "validate" | "bootstrap";

interface Options {
  mode: Mode;
  databases: string[];
  evidencePath: string | null;
  resolvingUnits: Map<string, string[]>;
}

interface DbEvidence {
  path: string;
  sha256: string;
  integrity: string;
  schemaVersion: number;
  schema: "legacy" | "migratable" | "current";
  legacyQueueCount: number;
  pendingQueueCount: number;
  tables: string[];
  pendingColumns: string[];
  lockColumns: string[];
  resolvingUnits: string[];
  role?: string;
}

const ALLOWED_TABLES = new Set([
  "advisor_attempts", "advisor_calls", "approvals", "bridge_events", "bridge_runs", "bridge_state",
  "compaction_attempts", "conversation_summaries", "conversation_turns", "execution_locks", "feature_plans",
  "github_links", "health_context", "pending_messages", "project_memories", "project_memories_fts",
  "project_memories_fts_config", "project_memories_fts_content", "project_memories_fts_data",
  "project_memories_fts_docsize", "project_memories_fts_idx", "prompts", "settings", "sqlite_sequence",
  "work_item_plans", "work_items", "work_jobs",
]);

const REQUIRED_TABLES = new Set(["bridge_state", "pending_messages", "settings"]);
const LEGACY_PENDING_COLUMNS = new Set([
  "id", "chat_key", "prompt", "chat_id", "thread_id", "chat_type", "user_id", "created_at",
]);
const CURRENT_PENDING_COLUMNS = new Set([
  ...LEGACY_PENDING_COLUMNS,
  "surface", "state", "claim_run_id", "claim_acquisition_id", "claimed_at", "attachments_json",
]);
const CURRENT_LOCK_COLUMNS = new Set([
  "surface", "chat_key", "service_id", "run_id", "acquisition_id", "acquired_at", "lease_expires_at",
]);

function parseArgs(argv: string[]): Options {
  const mode = argv.shift() as Mode | undefined;
  if (!mode || !["inspect", "migrate", "validate"].includes(mode)) {
    throw new Error("usage: rollout-db.ts <inspect|migrate|validate> --db PATH [--db PATH ...]");
  }
  const databases: string[] = [];
  let evidencePath: string | null = null;
  const resolvingUnits = new Map<string, string[]>();
  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--db") databases.push(value);
    else if (flag === "--evidence") evidencePath = value;
    else if (flag === "--resolving-unit") {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`--resolving-unit must be PATH=unit-name, got: ${value}`);
      }
      const path = value.slice(0, separator);
      const unit = value.slice(separator + 1);
      const existing = resolvingUnits.get(path) ?? [];
      existing.push(unit);
      resolvingUnits.set(path, existing);
    }
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (databases.length === 0) throw new Error("at least one --db path is required");
  return { mode, databases, evidencePath, resolvingUnits };
}

interface BootstrapOptions {
  path: string;
  role: string;
  evidencePath: string | null;
}

/**
 * Bootstrap's own arg parser (Phase 4C.3, issue #135): exactly one
 * `--db PATH --role NAME --confirm-new-role PATH` triplet per invocation —
 * deliberately not a loop over multiple targets. Sequential multi-target
 * bootstrap can partially commit: an earlier target publishes successfully,
 * a later one fails, and the invocation exits nonzero having already
 * mutated disk state with no way to tell which targets succeeded from the
 * exit code alone. One target per invocation makes success/failure an
 * atomic, unambiguous outcome for the whole process; bootstrapping several
 * new roles means separately-invoked, separately-confirmed runs, each with
 * its own evidence.
 *
 * The role is an explicit expected role (one of the five canonical roles,
 * structurally validated here — the role/path *pair* allowlist itself lives
 * in the root-owned bootstrap config, outside this script) and
 * --confirm-new-role is an exact-match confirmation that the missing file
 * is expected, not a symptom of misconfiguration or accidental deletion,
 * mirroring --expected-commit's exact-match discipline elsewhere in this
 * tooling.
 */
function parseBootstrapArgs(argv: string[]): BootstrapOptions {
  let path: string | null = null;
  let role: string | null = null;
  let confirm: string | null = null;
  let evidencePath: string | null = null;
  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--db") {
      if (path) throw new Error("bootstrap accepts exactly one --db per invocation — invoke separately for each new role");
      path = value;
    } else if (flag === "--role") {
      if (role) throw new Error("bootstrap accepts exactly one --role per invocation");
      if (!VALID_ROLES.has(value)) {
        throw new Error(`--role must be one of ${[...VALID_ROLES].join(", ")}, got: ${value}`);
      }
      role = value;
    } else if (flag === "--confirm-new-role") {
      if (confirm) throw new Error("bootstrap accepts exactly one --confirm-new-role per invocation");
      confirm = value;
    } else if (flag === "--evidence") {
      evidencePath = value;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!path) throw new Error("--db is required");
  if (!role) throw new Error("--role is required");
  if (!confirm) throw new Error("--confirm-new-role is required");
  if (confirm !== path) {
    throw new Error(`--confirm-new-role must exactly match --db (expected "${path}", got "${confirm}")`);
  }
  return { path, role, evidencePath };
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name).sort();
}

function sameSet(values: string[], expected: Set<string>): boolean {
  return values.length === expected.size && values.every((value) => expected.has(value));
}

function inspectDatabase(path: string, requireCurrent: boolean, resolvingUnits: string[] = []): DbEvidence {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw new Error(`integrity check failed for ${path}: ${integrity}`);
    const userVersion = Number(db.pragma("user_version", { simple: true }));
    if (userVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(`unsupported future schema version ${userVersion} for ${path}`);
    }
    if (!Number.isInteger(userVersion) || userVersion < 0) {
      throw new Error(`invalid schema version ${userVersion} for ${path}`);
    }
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    const unknownTables = tables.filter((table) => !ALLOWED_TABLES.has(table));
    const missingTables = [...REQUIRED_TABLES].filter((table) => !tables.includes(table));
    if (unknownTables.length > 0 || missingTables.length > 0) {
      throw new Error(`unknown schema for ${path}: unknown=[${unknownTables.join(",")}] missing=[${missingTables.join(",")}]`);
    }
    const pendingColumns = columnNames(db, "pending_messages");
    const invalidPending = pendingColumns.some((column) => !CURRENT_PENDING_COLUMNS.has(column))
      || [...LEGACY_PENDING_COLUMNS].some((column) => !pendingColumns.includes(column));
    if (invalidPending) throw new Error(`unknown schema for ${path}: unsupported pending_messages columns`);
    const lockColumns = tables.includes("execution_locks") ? columnNames(db, "execution_locks") : [];
    const currentPending = sameSet(pendingColumns, CURRENT_PENDING_COLUMNS);
    const currentLocks = sameSet(lockColumns, CURRENT_LOCK_COLUMNS);
    const schema = userVersion === 0
      ? "legacy"
      : currentPending && currentLocks
        ? "current"
      : sameSet(pendingColumns, LEGACY_PENDING_COLUMNS) && lockColumns.length === 0
        ? "legacy"
        : "migratable";
    if (requireCurrent && schema !== "current") throw new Error(`unknown schema after migration for ${path}: ${schema}`);
    const legacyQueueCount = pendingColumns.includes("surface")
      ? Number((db.prepare("SELECT COUNT(*) AS count FROM pending_messages WHERE surface = 'legacy'").get() as { count: number }).count)
      : Number((db.prepare("SELECT COUNT(*) AS count FROM pending_messages").get() as { count: number }).count);
    const pendingQueueCount = Number((db.prepare("SELECT COUNT(*) AS count FROM pending_messages").get() as { count: number }).count);
    return { path, sha256: hashFile(path), integrity, schemaVersion: userVersion, schema, legacyQueueCount, pendingQueueCount, tables, pendingColumns, lockColumns, resolvingUnits };
  } finally {
    db.close();
  }
}

/** True if anything at all exists at `path` — including a symlink, even a dangling one. Deliberately lstat-based (not existsSync, which follows symlinks and would report a dangling symlink as "nothing here"). */
function pathOccupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Same ownership/permission/no-symlink standard already applied to
 * `backup_dir`/`log_dir` by rollout-agent-bridge.sh: canonical, a real
 * directory (not a symlink), not group/world-writable. Root ownership
 * itself is proven at the shell-wrapper layer *before* it drops to the
 * unprivileged runtime user that actually executes this script — the same
 * layering `migrate` mode already relies on — so it is deliberately not
 * re-asserted here.
 */
function validateParentDir(dir: string): void {
  let parentStat;
  try {
    parentStat = lstatSync(dir);
  } catch {
    throw new Error(`parent directory is missing or symlinked: ${dir}`);
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`parent directory is missing or symlinked: ${dir}`);
  }
  if (realpathSync(dir) !== dir) throw new Error(`parent directory is not canonical: ${dir}`);
  if ((parentStat.mode & 0o022) !== 0) throw new Error(`parent directory must not be group/world writable: ${dir}`);
}

/** Validates the freshly-migrated temp database before it is ever published, per Phase 4C.3's "validate before publication" requirement. */
function validateBootstrapped(tempPath: string): void {
  const db = new Database(tempPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw new Error(`bootstrap integrity check failed for ${tempPath}: ${integrity}`);
    const fkViolations = db.pragma("foreign_key_check") as unknown[];
    if (Array.isArray(fkViolations) && fkViolations.length > 0) {
      throw new Error(`bootstrap left ${fkViolations.length} foreign key violation(s) in ${tempPath}`);
    }
    const userVersion = Number(db.pragma("user_version", { simple: true }));
    if (userVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`bootstrap did not reach CURRENT_SCHEMA_VERSION for ${tempPath}: got ${userVersion}`);
    }
  } finally {
    db.close();
  }
}

function removeSidecars(base: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try { rmSync(`${base}${suffix}`, { force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Test-only fault-injection hooks, gated so they can never fire against a
 * real production invocation just because a stray environment variable
 * happens to be set: honored only when AGENT_BRIDGE_BOOTSTRAP_TEST_MODE=1
 * is *also* explicitly set, and refused outright when running as root
 * (mirroring the shell rollout tooling's own "test root is forbidden
 * during root execution" rule) — bootstrap itself never runs as root in
 * production (the shell wrapper always drops to the runtime user first),
 * so this is defense in depth against a misconfigured or malicious
 * root-context invocation, not a path this script expects to take.
 */
const BOOTSTRAP_TEST_MODE = process.env.AGENT_BRIDGE_BOOTSTRAP_TEST_MODE === "1";
if (BOOTSTRAP_TEST_MODE && typeof process.getuid === "function" && process.getuid() === 0) {
  throw new Error("AGENT_BRIDGE_BOOTSTRAP_TEST_MODE is forbidden when running as root");
}
function testHook(name: string): string | undefined {
  return BOOTSTRAP_TEST_MODE ? process.env[name] : undefined;
}

/**
 * Escapes a string for literal use inside a RegExp.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Best-effort recovery for debris left by a *previous* bootstrap attempt on
 * this exact target that was interrupted in a way this process could never
 * catch — SIGKILL or a machine reboot between the atomic link() publish and
 * the temp name's unlink(), or any earlier failure whose own cleanup never
 * ran. Only ever removes files matching this target's own randomly-named
 * temp pattern (`.bootstrap-<32 hex chars>-<this target's basename>`, plus
 * its -wal/-shm sidecars) in the target's own directory — never touches
 * anything else. Safe to run unconditionally at the start of a new attempt
 * because the caller (rollout-bootstrap.sh) holds the same exclusive
 * rollout lock for the whole invocation, so no other legitimate process can
 * be concurrently using a leftover temp name for this target.
 */
function cleanupStaleTempFiles(dir: string, path: string): void {
  const pattern = new RegExp(`^\\.bootstrap-[0-9a-f]{32}-${escapeRegExp(basename(path))}(-wal|-shm)?$`);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!pattern.test(entry)) continue;
    try { rmSync(join(dir, entry), { force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Publishes with no-replace semantics: `link()` fails atomically with
 * EEXIST if anything now occupies `path`, including something that
 * appeared concurrently after every earlier check in this function ran —
 * unlike `rename()`, which would silently replace it. The temp path is
 * unlinked only after the link succeeds, so `path` and the temp name are
 * briefly two hard links to the same inode, never a window where neither
 * refers to the completed database.
 */
function publishAtomic(tempPath: string, path: string): void {
  try {
    linkSync(tempPath, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`destination appeared concurrently during publication, refusing to overwrite: ${path}`);
    }
    throw err;
  }
  unlinkSync(tempPath);
}

/**
 * Registers process-level cleanup for a graceful termination signal
 * (SIGTERM/SIGINT) received mid-bootstrap. This can only ever help for
 * *graceful* termination — SIGKILL and a machine power loss are, by
 * definition, unobservable by any process and cannot be handled here at
 * all; recovery from those specific cases is `cleanupStaleTempFiles()`'s
 * job on the *next* invocation, not this one's. Removes its own listeners
 * before re-raising so the process actually terminates with the expected
 * signal semantics rather than hanging or exiting 0.
 */
const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

async function withSignalCleanup<T>(tempPath: string, fn: () => Promise<T>): Promise<T> {
  const handler = (signal: NodeJS.Signals) => {
    try { rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
    removeSidecars(tempPath);
    process.stderr.write(`rollout-db: bootstrap interrupted by ${signal}, cleaned up temp state\n`);
    // Re-sending the signal to ourselves (process.kill(pid, signal)) after
    // removing our own handler does not reliably terminate the process in
    // the same tick — exiting explicitly with the conventional 128+N code
    // is the standard, dependable pattern for "cleaned up, now die". Note
    // this handler can only ever run at a genuine event-loop yield point
    // (an `await`, timer, or I/O callback) — a tight synchronous operation
    // (a long-running native call with no `await` in between) blocks Node
    // from servicing the pending signal at all until it returns, same as
    // any other Node.js signal handler.
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  try {
    return await fn();
  } finally {
    process.off("SIGTERM", handler);
    process.off("SIGINT", handler);
  }
}

/**
 * Bootstrap a single genuinely-missing database (Phase 4C.3, issue #135):
 * reuses openDb()'s existing missing-file path unchanged — it already
 * creates the file and runs it through migration 1's real DDL, the same
 * registered plan every other database goes through, so there is no
 * duplicated or shortcut schema definition here.
 *
 * Atomicity is layered on top of that unchanged path, not inside it: the
 * new database is created and migrated at a randomly-named temp path in the
 * *same* directory as the final target (so the eventual publish is same-
 * filesystem), validated (integrity, foreign keys, exact schema version),
 * then published with no-replace link()+unlink() semantics only after every
 * check passes. If anything fails synchronously — missing-file
 * precondition, parent validation, the migration itself, post-migration
 * validation, or publication racing a concurrently-created destination —
 * the temp file (and any -wal/-shm sidecars it produced) is removed and the
 * final path is left completely untouched. A graceful termination signal
 * (SIGTERM/SIGINT) mid-attempt is also cleaned up. SIGKILL or a machine
 * reboot between the atomic link() publish and the temp name's unlink()
 * cannot be observed or handled by this process at all — that specific,
 * narrow window can leave a harmless extra hard link (same inode, same
 * validated content as the published database, not a partial/corrupt file)
 * at a stale temp name; `cleanupStaleTempFiles()` removes it opportunistically
 * on the next bootstrap attempt against the same target, under the same
 * exclusive rollout lock.
 */
async function bootstrapDatabase(path: string, role: string): Promise<DbEvidence> {
  if (pathOccupied(path)) throw new Error(`database already exists, use migrate instead: ${path}`);
  const dir = dirname(path);
  validateParentDir(dir);
  cleanupStaleTempFiles(dir, path);
  const tempPath = join(dir, `.bootstrap-${randomBytes(16).toString("hex")}-${basename(path)}`);
  const cleanupTemp = () => {
    try { rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
    removeSidecars(tempPath);
  };
  try {
    await withSignalCleanup(tempPath, async () => {
      if (testHook("AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_MIGRATION_FAILURE") === path) {
        // Pre-creates a file at the exact temp path with a future,
        // unsupported schema version, so openDb()'s own existing
        // version-gate rejects it — a real migration-time failure, not a
        // simulated one.
        const raw = new Database(tempPath);
        raw.exec("PRAGMA user_version = 99;");
        raw.close();
      }
      openDb(tempPath, { serviceId: `rollout:bootstrap:${role}` }).close();
      const pauseFile = testHook("AGENT_BRIDGE_BOOTSTRAP_TEST_PAUSE_FILE");
      if (pauseFile) {
        // Test-only hook proving the SIGTERM/SIGINT cleanup path in
        // withSignalCleanup() actually runs, not just that it typechecks:
        // signals the test harness (by creating pauseFile) that the temp
        // database now exists on disk, then awaits — via a real
        // setTimeout-based async delay loop, a genuine event-loop yield
        // point, unlike a synchronous blocking call, which would prevent
        // Node from ever servicing the pending signal — until either a
        // resume file appears or a bounded deadline passes, so a broken
        // hook can't hang forever.
        writeFileSync(pauseFile, "paused\n");
        const resumeFile = `${pauseFile}.resume`;
        const deadline = Date.now() + 5000;
        while (!existsSync(resumeFile) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      if (testHook("AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_INVALID_SCHEMA") === path) {
        const raw = new Database(tempPath);
        raw.exec("PRAGMA user_version = 4242;");
        raw.close();
      }
      validateBootstrapped(tempPath);
      if (testHook("AGENT_BRIDGE_BOOTSTRAP_TEST_PRE_PUBLISH_OCCUPY") === path) {
        writeFileSync(path, "concurrently created by a different process\n");
      }
      publishAtomic(tempPath, path);
    });
  } catch (err) {
    cleanupTemp();
    throw err;
  }
  removeSidecars(tempPath);
  const evidence = inspectDatabase(path, true);
  return { ...evidence, role };
}

function writeEvidence(path: string | null, mode: Mode, databases: DbEvidence[]): void {
  if (!path) return;
  const content = `${JSON.stringify({ mode, createdAt: new Date().toISOString(), databases }, null, 2)}\n`;
  if (path === "-") {
    process.stdout.write(content);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "bootstrap") {
    const options = parseBootstrapArgs(argv.slice(1));
    const evidence = await bootstrapDatabase(options.path, options.role);
    writeEvidence(options.evidencePath, "bootstrap", [evidence]);
    return;
  }
  const options = parseArgs(argv);
  const unitsFor = (path: string) => options.resolvingUnits.get(path) ?? [];
  if (options.mode === "inspect") {
    const evidence = options.databases.map((path) => inspectDatabase(path, false, unitsFor(path)));
    const legacyQueues = evidence.reduce((sum, database) => sum + database.legacyQueueCount, 0);
    if (legacyQueues !== 0) throw new Error(`legacy queue count is nonzero: ${legacyQueues}`);
    writeEvidence(options.evidencePath, options.mode, evidence);
    return;
  }
  if (options.mode === "migrate") {
    for (const path of options.databases) openDb(path, { serviceId: "rollout:migration" }).close();
    writeEvidence(options.evidencePath, options.mode, options.databases.map((path) => inspectDatabase(path, true, unitsFor(path))));
    return;
  }
  const evidence = options.databases.map((path) => inspectDatabase(path, true, unitsFor(path)));
  const legacyQueues = evidence.reduce((sum, database) => sum + database.legacyQueueCount, 0);
  if (legacyQueues !== 0) throw new Error(`legacy queue count is nonzero after migration: ${legacyQueues}`);
  writeEvidence(options.evidencePath, options.mode, evidence);
}

main().catch((error) => {
  process.stderr.write(`rollout-db: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
