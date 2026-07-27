/**
 * PURPOSE: Secure, fail-closed relocation of the health check database to the proper runtime directory.
 * INPUTS: Configurable paths for old db, new db, config files, and testing hooks.
 * OUTPUTS: Explicit WAL-safe backup, verification of schema/integrity/provenance, atomic installation, environment update, and rollback.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";

interface RelocateOptions {
  oldPath: string;
  newPath: string;
  envFilePath: string;
  rolloutConfigPath: string;
  serviceName: string;
  runtimeUser?: string;
}

export async function relocateHealthDb(options: RelocateOptions): Promise<void> {
  const TEST_ROOT = process.env.AGENT_BRIDGE_ROLLOUT_TEST_ROOT || "";
  const { oldPath, newPath, envFilePath, rolloutConfigPath, serviceName } = options;
  console.log(`[relocate-health-db] Starting migration: ${oldPath} -> ${newPath}`);

  // Resolve absolute paths under test root
  const resolvedOldPath = TEST_ROOT ? join(TEST_ROOT, oldPath) : oldPath;
  const resolvedNewPath = TEST_ROOT ? join(TEST_ROOT, newPath) : newPath;
  const resolvedEnvFilePath = TEST_ROOT ? join(TEST_ROOT, envFilePath) : envFilePath;
  const resolvedRolloutConfigPath = TEST_ROOT ? join(TEST_ROOT, rolloutConfigPath) : rolloutConfigPath;

  const systemctl = TEST_ROOT ? join(TEST_ROOT, "bin/systemctl") : "/usr/bin/systemctl";

  // Check if old database exists
  if (!existsSync(resolvedOldPath)) {
    throw new Error(`Source database does not exist: ${resolvedOldPath}`);
  }

  // Check if destination database already exists
  if (existsSync(resolvedNewPath)) {
    throw new Error(`Destination database already occupied: ${resolvedNewPath}`);
  }

  // Pre-calculate temp paths
  const newDir = dirname(resolvedNewPath);
  const tempBackupPath = join(newDir, `.relocate-backup-${Date.now()}-${basename(resolvedNewPath)}`);

  // Flags for rollback
  let serviceWasRunning = false;
  let backupCreated = false;
  let installedAtDest = false;
  let oldDbRenamed = false;
  let envFileModified = false;
  let rolloutConfigModified = false;

  let originalEnvFileContent = "";
  let originalRolloutConfigContent = "";

  const rollback = async () => {
    console.error("[relocate-health-db] Relocation failed. Initiating rollback...");

    // 1. Restore rollout configuration
    if (rolloutConfigModified && originalRolloutConfigContent) {
      try {
        writeFileSync(resolvedRolloutConfigPath, originalRolloutConfigContent);
        console.log(`[relocate-health-db] Restored rollout configuration: ${resolvedRolloutConfigPath}`);
      } catch (err: any) {
        console.error(`[relocate-health-db] Failed to restore rollout config during rollback: ${err.message}`);
      }
    }

    // 2. Restore environment file
    if (envFileModified && originalEnvFileContent) {
      try {
        writeFileSync(resolvedEnvFilePath, originalEnvFileContent);
        console.log(`[relocate-health-db] Restored environment file: ${resolvedEnvFilePath}`);
      } catch (err: any) {
        console.error(`[relocate-health-db] Failed to restore env file during rollback: ${err.message}`);
      }
    }

    // 3. Move old database back if renamed
    if (oldDbRenamed) {
      try {
        if (existsSync(resolvedOldPath + ".stale-backup") && !existsSync(resolvedOldPath)) {
          renameSync(resolvedOldPath + ".stale-backup", resolvedOldPath);
          console.log(`[relocate-health-db] Restored old database from stale backup: ${resolvedOldPath}`);
        }
      } catch (err: any) {
        console.error(`[relocate-health-db] Failed to restore old database file during rollback: ${err.message}`);
      }
    }

    // 4. Remove target database if installed
    if (installedAtDest) {
      try {
        rmSync(resolvedNewPath, { force: true });
        rmSync(resolvedNewPath + "-wal", { force: true });
        rmSync(resolvedNewPath + "-shm", { force: true });
        console.log(`[relocate-health-db] Removed destination files: ${resolvedNewPath}`);
      } catch (err: any) {
        console.error(`[relocate-health-db] Failed to remove destination database during rollback: ${err.message}`);
      }
    }

    // 5. Remove temporary backup
    if (backupCreated) {
      try {
        rmSync(tempBackupPath, { force: true });
        rmSync(tempBackupPath + "-wal", { force: true });
        rmSync(tempBackupPath + "-shm", { force: true });
      } catch (err: any) {
        // best effort
      }
    }

    // 6. Restart the service if it was running before
    if (serviceWasRunning) {
      try {
        console.log(`[relocate-health-db] Restarting service ${serviceName}...`);
        if (existsSync(systemctl)) {
          execFileSync(systemctl, ["start", serviceName]);
        }
      } catch (err: any) {
        console.error(`[relocate-health-db] Failed to restart service during rollback: ${err.message}`);
      }
    }
  };

  try {
    // Step 1: Check and Stop/Quiesce service
    if (existsSync(systemctl)) {
      try {
        const isActive = execFileSync(systemctl, ["is-active", serviceName], { encoding: "utf8" }).trim() === "active";
        if (isActive) {
          serviceWasRunning = true;
          console.log(`[relocate-health-db] Stopping service ${serviceName}...`);
          execFileSync(systemctl, ["stop", serviceName]);
        }
      } catch (err) {
        // systemctl is-active returns non-zero when inactive, which is expected
      }
    }

    // Ensure target directory exists
    mkdirSync(newDir, { recursive: true });

    // Step 2: Capture WAL-safe online backup of old database
    console.log(`[relocate-health-db] Backing up source database: ${resolvedOldPath} -> ${tempBackupPath}`);
    const sourceDb = new Database(resolvedOldPath, { fileMustExist: true });
    try {
      await sourceDb.backup(tempBackupPath);
      backupCreated = true;
    } finally {
      sourceDb.close();
    }

    // Step 3: Validate integrity, foreign keys, schema, and installation provenance on the backup copy
    console.log(`[relocate-health-db] Validating backup copy: ${tempBackupPath}`);
    const backupDb = new Database(tempBackupPath, { fileMustExist: true });
    try {
      // 3.1 Integrity check
      const integrity = backupDb.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") {
        throw new Error(`Integrity check failed: ${integrity}`);
      }

      // 3.2 Foreign key check
      const fk = backupDb.pragma("foreign_key_check");
      if (Array.isArray(fk) && fk.length > 0) {
        throw new Error(`Foreign key check failed: ${JSON.stringify(fk)}`);
      }

      // 3.3 Schema version check
      const schemaVersion = Number(backupDb.pragma("user_version", { simple: true }));
      if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
        throw new Error(`Schema version is not current: expected ${CURRENT_SCHEMA_VERSION}, got ${schemaVersion}`);
      }

      // 3.4 Installation provenance validation
      const installationId = backupDb.prepare("SELECT value FROM settings WHERE key = 'agent_bridge_installation_id'").get()?.value;
      if (!installationId) {
        throw new Error("Missing installation identity in settings");
      }

      const provenanceText = backupDb.prepare("SELECT value FROM settings WHERE key = 'agent_bridge_database_provenance'").get()?.value;
      if (!provenanceText) {
        throw new Error("Missing database provenance settings in backup");
      }

      let provenance: any;
      try {
        provenance = JSON.parse(provenanceText);
      } catch {
        throw new Error("Provenance setting is malformed JSON");
      }

      if (provenance.role !== "health") {
        throw new Error(`Invalid database role in provenance: expected 'health', got '${provenance.role}'`);
      }

      // Step 4: Update provenance path inside the backup database to point to the new location
      console.log(`[relocate-health-db] Updating database provenance path to: ${newPath}`);
      provenance.path = newPath;
      backupDb.prepare("UPDATE settings SET value = ? WHERE key = 'agent_bridge_database_provenance'").run(JSON.stringify(provenance));
    } finally {
      backupDb.close();
    }

    // Step 5: Install database at new path with correct permissions
    console.log(`[relocate-health-db] Installing database at: ${resolvedNewPath}`);
    renameSync(tempBackupPath, resolvedNewPath);
    installedAtDest = true;

    // Set permission to 0o600 (owner read-write only)
    chmodSync(resolvedNewPath, 0o600);

    // If running as root in production, set ownership to the runtime user if available
    if (!TEST_ROOT && process.getuid?.() === 0 && options.runtimeUser) {
      try {
        execFileSync("/usr/bin/chown", [options.runtimeUser, resolvedNewPath]);
      } catch (err: any) {
        console.warn(`[relocate-health-db] Warning: Failed to set ownership to ${options.runtimeUser}: ${err.message}`);
      }
    }

    // Step 6: Preserve old database for rollback
    console.log(`[relocate-health-db] Preserving old database as backup`);
    renameSync(resolvedOldPath, resolvedOldPath + ".stale-backup");
    oldDbRenamed = true;

    // Step 7: Update env file and rollout inventory configuration
    if (existsSync(resolvedEnvFilePath)) {
      console.log(`[relocate-health-db] Updating environment file: ${resolvedEnvFilePath}`);
      originalEnvFileContent = readFileSync(resolvedEnvFilePath, "utf8");
      
      // Update HEALTH_DB_PATH setting
      let updatedEnv = originalEnvFileContent;
      if (updatedEnv.includes("HEALTH_DB_PATH=")) {
        updatedEnv = updatedEnv.replace(/^HEALTH_DB_PATH=.*$/m, `HEALTH_DB_PATH=${newPath}`);
      } else {
        updatedEnv += `\nHEALTH_DB_PATH=${newPath}\n`;
      }
      
      writeFileSync(resolvedEnvFilePath, updatedEnv);
      envFileModified = true;
    }

    if (existsSync(resolvedRolloutConfigPath)) {
      console.log(`[relocate-health-db] Updating rollout configuration inventory: ${resolvedRolloutConfigPath}`);
      originalRolloutConfigContent = readFileSync(resolvedRolloutConfigPath, "utf8");
      
      let updatedRollout = originalRolloutConfigContent;
      const oldConfigDbLine = `database=${oldPath}`;
      const newConfigDbLine = `database=${newPath}`;
      if (updatedRollout.includes(oldConfigDbLine)) {
        updatedRollout = updatedRollout.replace(new RegExp(oldConfigDbLine, "g"), newConfigDbLine);
      } else if (!updatedRollout.includes(newConfigDbLine)) {
        updatedRollout += `\n${newConfigDbLine}\n`;
      }
      
      writeFileSync(resolvedRolloutConfigPath, updatedRollout);
      rolloutConfigModified = true;
    }

    // Step 8: Restart service
    if (serviceWasRunning && existsSync(systemctl)) {
      console.log(`[relocate-health-db] Starting service ${serviceName}...`);
      execFileSync(systemctl, ["start", serviceName]);
    }

    console.log("[relocate-health-db] Health database relocation completed successfully!");
  } catch (error) {
    await rollback();
    throw error;
  }
}
if (process.argv[1] && (process.argv[1].endsWith("relocate-health-db.ts") || process.argv[1].endsWith("relocate-health-db.js"))) {
  const oldPath = process.env.HEALTH_DB_OLD_PATH || "/home/content-crawler/agent-bridge/.data-health/health.sqlite";
  const newPath = process.env.HEALTH_DB_NEW_PATH || "/home/content-crawler/runtime/agent-bridge/health/health.sqlite";
  const envFilePath = process.env.HEALTH_ENV_FILE_PATH || "/etc/default/agent-bridge-health";
  const rolloutConfigPath = process.env.HEALTH_ROLLOUT_CONFIG_PATH || "/etc/agent-bridge/rollout.conf";
  const serviceName = process.env.HEALTH_SERVICE_NAME || "agent-bridge-health.service";
  const runtimeUser = process.env.HEALTH_RUNTIME_USER || "content-crawler";

  relocateHealthDb({
    oldPath,
    newPath,
    envFilePath,
    rolloutConfigPath,
    serviceName,
    runtimeUser,
  }).catch((err) => {
    console.error(`Relocation failed: ${err.message}`);
    process.exit(1);
  });
}
