/**
 * PURPOSE: Inspect, migrate, and validate the root-resolved SQLite inventory used by guarded production rollouts.
 * INPUTS: A rollout phase, evidence path, and an explicit list of existing SQLite database files.
 * OUTPUTS: Metadata-only schema, integrity, queue, and hash evidence.
 * NEIGHBORS: scripts/rollout-agent-bridge.sh, src/db.ts
 * LOGIC: Rejects unknown schemas before mutation, runs existing openDb migrations, and validates the exact current lane/queue columns.
 */

import { createHash, randomBytes } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

interface BootstrapTarget {
  path: string;
  role: string;
}

interface BootstrapOptions {
  targets: BootstrapTarget[];
  evidencePath: string | null;
}

/**
 * Bootstrap's own arg parser (Phase 4C.3, issue #135). Each target is a
 * strict `--db PATH --role NAME --confirm-new-role PATH` triplet, in that
 * exact order: an explicit expected role (one of the five canonical roles,
 * structurally validated here — the role/path *pair* allowlist itself lives
 * in the root-owned bootstrap config, outside this script) and an exact-
 * match confirmation that the missing file is expected, not a symptom of
 * misconfiguration or accidental deletion, mirroring --expected-commit's
 * exact-match discipline elsewhere in this tooling.
 */
function parseBootstrapArgs(argv: string[]): BootstrapOptions {
  const targets: BootstrapTarget[] = [];
  let evidencePath: string | null = null;
  let pendingPath: string | null = null;
  let pendingRole: string | null = null;
  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--db") {
      if (pendingPath) throw new Error(`--db ${pendingPath} is missing its --role/--confirm-new-role`);
      pendingPath = value;
    } else if (flag === "--role") {
      if (!pendingPath) throw new Error("--role must immediately follow its --db");
      if (pendingRole) throw new Error(`--db ${pendingPath} already has a --role`);
      if (!VALID_ROLES.has(value)) {
        throw new Error(`--role must be one of ${[...VALID_ROLES].join(", ")}, got: ${value}`);
      }
      pendingRole = value;
    } else if (flag === "--confirm-new-role") {
      if (!pendingPath) throw new Error("--confirm-new-role must immediately follow its --db and --role");
      if (!pendingRole) throw new Error(`--db ${pendingPath} is missing its --role before --confirm-new-role`);
      if (value !== pendingPath) {
        throw new Error(`--confirm-new-role must exactly match the immediately preceding --db path (expected "${pendingPath}", got "${value}")`);
      }
      targets.push({ path: pendingPath, role: pendingRole });
      pendingPath = null;
      pendingRole = null;
    } else if (flag === "--evidence") {
      evidencePath = value;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (pendingPath) throw new Error(`--db ${pendingPath} is missing its --role/--confirm-new-role`);
  if (targets.length === 0) throw new Error("at least one --db path is required");
  return { targets, evidencePath };
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
 * check passes. If anything fails — missing-file precondition, parent
 * validation, the migration itself, post-migration validation, or
 * publication racing a concurrently-created destination — the temp file
 * (and any -wal/-shm sidecars it produced) is removed and the final path is
 * left completely untouched, so a partial or interrupted bootstrap never
 * leaves debris at either path and never overwrites anything.
 */
function bootstrapDatabase(path: string, role: string): DbEvidence {
  if (pathOccupied(path)) throw new Error(`database already exists, use migrate instead: ${path}`);
  const dir = dirname(path);
  validateParentDir(dir);
  const tempPath = join(dir, `.bootstrap-${randomBytes(16).toString("hex")}-${basename(path)}`);
  const cleanupTemp = () => {
    try { rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
    removeSidecars(tempPath);
  };
  try {
    if (process.env.AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_MIGRATION_FAILURE === path) {
      // Pre-creates a file at the exact temp path with a future, unsupported
      // schema version, so openDb()'s own existing version-gate rejects it —
      // a real migration-time failure, not a simulated one.
      const raw = new Database(tempPath);
      raw.exec("PRAGMA user_version = 99;");
      raw.close();
    }
    openDb(tempPath, { serviceId: `rollout:bootstrap:${role}` }).close();
    if (process.env.AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_INVALID_SCHEMA === path) {
      const raw = new Database(tempPath);
      raw.exec("PRAGMA user_version = 4242;");
      raw.close();
    }
    validateBootstrapped(tempPath);
    if (process.env.AGENT_BRIDGE_BOOTSTRAP_TEST_PRE_PUBLISH_OCCUPY === path) {
      writeFileSync(path, "concurrently created by a different process\n");
    }
    publishAtomic(tempPath, path);
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
    const evidence = options.targets.map((target) => bootstrapDatabase(target.path, target.role));
    writeEvidence(options.evidencePath, "bootstrap", evidence);
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
