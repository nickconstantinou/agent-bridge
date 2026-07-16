/**
 * PURPOSE: Inspect, back up, migrate, and validate the fixed SQLite inventory used by guarded production rollouts.
 * INPUTS: A rollout phase, evidence/backup paths, and an explicit list of existing SQLite database files.
 * OUTPUTS: Consistent SQLite backups plus metadata-only schema, integrity, queue, and hash evidence.
 * NEIGHBORS: scripts/rollout-agent-bridge.sh, src/db.ts
 * LOGIC: Rejects unknown schemas before mutation, makes byte-exact stopped-database backups, runs existing openDb migrations, and validates the exact current lane/queue columns.
 */

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";

type Mode = "inspect" | "backup" | "migrate" | "validate";

interface Options {
  mode: Mode;
  databases: string[];
  evidencePath: string | null;
  backupDir: string | null;
  manifestPath: string | null;
}

interface DbEvidence {
  path: string;
  sha256: string;
  integrity: string;
  schema: "legacy" | "migratable" | "current";
  legacyQueueCount: number;
  pendingQueueCount: number;
  tables: string[];
  pendingColumns: string[];
  lockColumns: string[];
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
  if (!mode || !["inspect", "backup", "migrate", "validate"].includes(mode)) {
    throw new Error("usage: rollout-db.ts <inspect|backup|migrate|validate> --db PATH [--db PATH ...]");
  }
  const databases: string[] = [];
  let evidencePath: string | null = null;
  let backupDir: string | null = null;
  let manifestPath: string | null = null;
  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--db") databases.push(value);
    else if (flag === "--evidence") evidencePath = value;
    else if (flag === "--backup-dir") backupDir = value;
    else if (flag === "--manifest") manifestPath = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (databases.length === 0) throw new Error("at least one --db path is required");
  if (mode === "backup" && (!backupDir || !manifestPath)) {
    throw new Error("backup requires --backup-dir and --manifest");
  }
  return { mode, databases, evidencePath, backupDir, manifestPath };
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

function inspectDatabase(path: string, requireCurrent: boolean): DbEvidence {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw new Error(`integrity check failed for ${path}: ${integrity}`);
    const userVersion = Number(db.pragma("user_version", { simple: true }));
    if (userVersion !== 0) throw new Error(`unknown schema version ${userVersion} for ${path}`);
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
    const schema = currentPending && currentLocks
      ? "current"
      : sameSet(pendingColumns, LEGACY_PENDING_COLUMNS) && lockColumns.length === 0
        ? "legacy"
        : "migratable";
    if (requireCurrent && schema !== "current") throw new Error(`unknown schema after migration for ${path}: ${schema}`);
    const legacyQueueCount = pendingColumns.includes("surface")
      ? Number((db.prepare("SELECT COUNT(*) AS count FROM pending_messages WHERE surface = 'legacy'").get() as { count: number }).count)
      : Number((db.prepare("SELECT COUNT(*) AS count FROM pending_messages").get() as { count: number }).count);
    const pendingQueueCount = Number((db.prepare("SELECT COUNT(*) AS count FROM pending_messages").get() as { count: number }).count);
    return { path, sha256: hashFile(path), integrity, schema, legacyQueueCount, pendingQueueCount, tables, pendingColumns, lockColumns };
  } finally {
    db.close();
  }
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

function backupDatabases(options: Options): void {
  mkdirSync(options.backupDir!, { recursive: true });
  const manifest: string[] = ["source\tbackup\tsource_sha256\tbackup_sha256"];
  for (const [index, source] of options.databases.entries()) {
    if (existsSync(`${source}-wal`) || existsSync(`${source}-shm`)) {
      throw new Error(`database has live WAL/SHM sidecars after service stop: ${source}`);
    }
    const backup = join(options.backupDir!, `${String(index + 1).padStart(2, "0")}-${basename(source)}`);
    copyFileSync(source, backup);
    chmodSync(backup, 0o600);
    const sourceHash = hashFile(source);
    const backupHash = hashFile(backup);
    if (sourceHash !== backupHash) throw new Error(`byte-exact backup verification failed for ${source}`);
    manifest.push([source, backup, sourceHash, backupHash].join("\t"));
  }
  const content = `${manifest.join("\n")}\n`;
  if (options.manifestPath === "-") process.stdout.write(content);
  else writeFileSync(options.manifestPath!, content, { mode: 0o600 });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "inspect") {
    const evidence = options.databases.map((path) => inspectDatabase(path, false));
    const legacyQueues = evidence.reduce((sum, database) => sum + database.legacyQueueCount, 0);
    if (legacyQueues !== 0) throw new Error(`legacy queue count is nonzero: ${legacyQueues}`);
    writeEvidence(options.evidencePath, options.mode, evidence);
    return;
  }
  if (options.mode === "backup") {
    backupDatabases(options);
    return;
  }
  if (options.mode === "migrate") {
    for (const path of options.databases) openDb(path, { serviceId: "rollout:migration" }).close();
    writeEvidence(options.evidencePath, options.mode, options.databases.map((path) => inspectDatabase(path, true)));
    return;
  }
  const evidence = options.databases.map((path) => inspectDatabase(path, true));
  const legacyQueues = evidence.reduce((sum, database) => sum + database.legacyQueueCount, 0);
  if (legacyQueues !== 0) throw new Error(`legacy queue count is nonzero after migration: ${legacyQueues}`);
  writeEvidence(options.evidencePath, options.mode, evidence);
}

main().catch((error) => {
  process.stderr.write(`rollout-db: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
