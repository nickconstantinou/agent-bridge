/**
 * PURPOSE: Secure, fail-closed relocation of the health check database to the proper runtime directory.
 * INPUTS: Configurable paths for old db, new db, config files, and testing hooks.
 * OUTPUTS: Explicit WAL-safe backup, verification of schema/integrity/provenance, atomic installation, environment update, and rollback.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync, statSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";

interface RelocateOptions {
  oldPath: string;
  newPath: string;
  envFilePath: string;
  rolloutConfigPath: string;
  serviceName: string;
  runtimeUser?: string;
  expectedInstallationId?: string;
  expectedCommit?: string;
  authorizationFile?: string;
  authorizationValidatorSha256?: string;
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

  // Pre-calculate temp paths
  const newDir = dirname(resolvedNewPath);
  const tempBackupPath = join(newDir, `.relocate-backup-${Date.now()}-${basename(resolvedNewPath)}`);

  // Durable Ledger and Sentinel paths
  const sentinelFile = TEST_ROOT
    ? join(TEST_ROOT, "run/agent-bridge/.health-relocation-in-progress")
    : "/run/agent-bridge/.health-relocation-in-progress";

  const ledgerFile = TEST_ROOT
    ? join(TEST_ROOT, "run/agent-bridge/.health-relocation-ledger.json")
    : "/run/agent-bridge/.health-relocation-ledger.json";

  const lockFile = TEST_ROOT
    ? join(TEST_ROOT, "run/lock/agent-bridge-rollout.lock")
    : "/run/lock/agent-bridge-rollout.lock";

  // Helper: ensure path has no forbidden symlinks in the path or any ancestor directories
  const ensureNotSymlink = (pathToCheck: string) => {
    try {
      if (existsSync(pathToCheck)) {
        const stat = lstatSync(pathToCheck);
        if (stat.isSymbolicLink()) {
          throw new Error(`Path ${pathToCheck} is a symbolic link, which is forbidden.`);
        }
      }
      // Check all parent ancestors
      let current = pathToCheck;
      while (true) {
        const parent = dirname(current);
        if (!parent || parent === current || parent === "/" || parent === ".") {
          break;
        }
        if (existsSync(parent)) {
          const stat = lstatSync(parent);
          if (stat.isSymbolicLink()) {
            throw new Error(`Ancestor directory ${parent} is a symbolic link, which is forbidden.`);
          }
        }
        current = parent;
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  };

  // Ensure no symlinks for input files
  ensureNotSymlink(resolvedOldPath);
  ensureNotSymlink(resolvedEnvFilePath);
  ensureNotSymlink(resolvedRolloutConfigPath);

  // Helper: safe atomic write via tmp file
  const safeWriteFile = (targetPath: string, content: string, mode?: number) => {
    ensureNotSymlink(targetPath);
    const tmpPath = targetPath + `.tmp-${randomBytes(8).toString("hex")}`;
    writeFileSync(tmpPath, content, mode ? { mode } : undefined);
    renameSync(tmpPath, targetPath);
  };

  // 1. Rollout Lock and Sentinel checks
  const flockBin = "/usr/bin/flock";
  if (existsSync(flockBin)) {
    try {
      mkdirSync(dirname(lockFile), { recursive: true });
      if (!existsSync(lockFile)) writeFileSync(lockFile, "");
      execFileSync(flockBin, ["--exclusive", "--nonblock", lockFile, "true"]);
    } catch (err: any) {
      throw new Error(`Another rollout is already active (could not acquire rollout lock: ${lockFile})`);
    }
  }

  if (existsSync(sentinelFile)) {
    throw new Error(`Relocation sentinel file exists: ${sentinelFile}. A previous relocation attempt may have been interrupted. Manual review is required.`);
  }

  // Create sentinel file atomically
  mkdirSync(dirname(sentinelFile), { recursive: true });
  safeWriteFile(sentinelFile, `${Date.now()}\n`);

  // Target commit binding and authorization validation
  const isProduction = !TEST_ROOT;
  const finalExpectedCommit = options.expectedCommit || process.env.HEALTH_EXPECTED_COMMIT || "";
  const finalAuthFile = options.authorizationFile || process.env.HEALTH_AUTHORIZATION_FILE || "";

  if (isProduction && (!finalExpectedCommit || !finalAuthFile)) {
    throw new Error("Production relocation requires expectedCommit and authorizationFile parameters (or environment variables)");
  }

  if (finalExpectedCommit) {
    let gitHead = "";
    try {
      gitHead = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch (err: any) {
      throw new Error(`Failed to read active git HEAD: ${err.message}`);
    }
    if (gitHead !== finalExpectedCommit) {
      throw new Error(`Target commit mismatch: active git HEAD is ${gitHead}, expected ${finalExpectedCommit}`);
    }
  }

  if (finalAuthFile) {
    const authValidator = TEST_ROOT 
      ? join(TEST_ROOT, "bin/rollout-authorization-trusted")
      : "/usr/local/libexec/agent-bridge-rollout-authorization.py";
    
    if (!existsSync(authValidator)) {
      throw new Error(`Rollout authorization validator not found at ${authValidator}`);
    }

    const finalAuthValidatorSha = options.authorizationValidatorSha256 || process.env.HEALTH_AUTHORIZATION_VALIDATOR_SHA256 || "";
    if (finalAuthValidatorSha) {
      const fileBytes = readFileSync(authValidator);
      const sha = createHash("sha256").update(fileBytes).digest("hex");
      if (sha !== finalAuthValidatorSha) {
        throw new Error(`Authorization validator hash mismatch: expected ${finalAuthValidatorSha}, got ${sha}`);
      }
    }
    
    try {
      execFileSync(authValidator, ["--file", finalAuthFile, "--expected-commit", finalExpectedCommit]);
      console.log(`[relocate-health-db] Rollout authorization verified successfully!`);
    } catch (err: any) {
      throw new Error(`Rollout authorization validation failed: ${err.message}`);
    }
  }

  const expectedInstallationId = options.expectedInstallationId || process.env.AGENT_BRIDGE_INSTALLATION_ID || "";
  if (isProduction && !expectedInstallationId) {
    throw new Error("Expected installation ID is required for verification (set AGENT_BRIDGE_INSTALLATION_ID)");
  }

  // Check if old database exists
  if (!existsSync(resolvedOldPath)) {
    if (existsSync(resolvedOldPath + ".stale-backup")) {
      console.log(`[relocate-health-db] Source database missing but stale backup exists. Restoring stale backup to recover...`);
      renameSync(resolvedOldPath + ".stale-backup", resolvedOldPath);
    } else {
      throw new Error(`Source database does not exist: ${resolvedOldPath}`);
    }
  }

  // Check if destination database already exists
  if (existsSync(resolvedNewPath)) {
    throw new Error(`Destination database already occupied: ${resolvedNewPath}`);
  }

  // Check if config files exist
  if (!existsSync(resolvedEnvFilePath)) {
    throw new Error(`Environment file does not exist: ${resolvedEnvFilePath}`);
  }
  if (!existsSync(resolvedRolloutConfigPath)) {
    throw new Error(`Rollout config file does not exist: ${resolvedRolloutConfigPath}`);
  }

  // Flags for rollback
  let serviceWasRunning = false;
  let originalEnvFileContent = "";
  let originalRolloutConfigContent = "";

  // Durable Ledger Steps
  let ledgerSteps: string[] = [];
  const updateLedger = (step: string) => {
    ledgerSteps.push(step);
    safeWriteFile(ledgerFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      expectedCommit: finalExpectedCommit,
      steps: ledgerSteps
    }, null, 2));
  };

  const rollback = async () => {
    console.error("[relocate-health-db] Relocation failed. Initiating rollback...");
    let rollbackSuccess = true;

    // Read the ledger to know exactly what steps were performed
    let stepsToRollback = [...ledgerSteps];
    if (existsSync(ledgerFile)) {
      try {
        const data = JSON.parse(readFileSync(ledgerFile, "utf8"));
        if (Array.isArray(data.steps)) {
          stepsToRollback = data.steps;
        }
      } catch (err) {
        // use local state if ledger cannot be read
      }
    }

    // Rollback steps in reverse order
    for (let i = stepsToRollback.length - 1; i >= 0; i--) {
      const step = stepsToRollback[i];
      if (step === "rollout-config-updated" && originalRolloutConfigContent) {
        try {
          safeWriteFile(resolvedRolloutConfigPath, originalRolloutConfigContent);
          console.log(`[relocate-health-db] Restored rollout configuration: ${resolvedRolloutConfigPath}`);
        } catch (err: any) {
          console.error(`[relocate-health-db] Failed to restore rollout config: ${err.message}`);
          rollbackSuccess = false;
        }
      }
      if (step === "env-file-updated" && originalEnvFileContent) {
        try {
          safeWriteFile(resolvedEnvFilePath, originalEnvFileContent);
          console.log(`[relocate-health-db] Restored environment file: ${resolvedEnvFilePath}`);
        } catch (err: any) {
          console.error(`[relocate-health-db] Failed to restore env file: ${err.message}`);
          rollbackSuccess = false;
        }
      }
      if (step === "old-database-renamed") {
        try {
          if (existsSync(resolvedOldPath + ".stale-backup") && !existsSync(resolvedOldPath)) {
            renameSync(resolvedOldPath + ".stale-backup", resolvedOldPath);
            console.log(`[relocate-health-db] Restored old database from stale backup: ${resolvedOldPath}`);
          }
        } catch (err: any) {
          console.error(`[relocate-health-db] Failed to restore old database file: ${err.message}`);
          rollbackSuccess = false;
        }
      }
      if (step === "database-installed") {
        try {
          rmSync(resolvedNewPath, { force: true });
          rmSync(resolvedNewPath + "-wal", { force: true });
          rmSync(resolvedNewPath + "-shm", { force: true });
          console.log(`[relocate-health-db] Removed destination files: ${resolvedNewPath}`);
        } catch (err: any) {
          console.error(`[relocate-health-db] Failed to remove destination database: ${err.message}`);
          rollbackSuccess = false;
        }
      }
      if (step === "backup-created") {
        try {
          rmSync(tempBackupPath, { force: true });
          rmSync(tempBackupPath + "-wal", { force: true });
          rmSync(tempBackupPath + "-shm", { force: true });
        } catch (err) {
          // ignore best effort
        }
      }
      if (step === "service-stopped" && serviceWasRunning) {
        try {
          console.log(`[relocate-health-db] Restarting service ${serviceName}...`);
          execFileSync(systemctl, ["start", serviceName]);
        } catch (err: any) {
          console.error(`[relocate-health-db] Failed to restart service: ${err.message}`);
          rollbackSuccess = false;
        }
      }
    }

    if (rollbackSuccess) {
      // Remove ledger and sentinel only if rollback succeeded completely
      rmSync(ledgerFile, { force: true });
      rmSync(sentinelFile, { force: true });
    } else {
      throw new Error("Relocation failed, and rollback restoration failed to restore complete original state. Manual recovery is required.");
    }
  };

  try {
    // Step 1: Check and Stop/Quiesce service
    if (!existsSync(systemctl)) {
      throw new Error(`systemctl binary not found at ${systemctl}`);
    }

    let isActive = false;
    try {
      const stdout = execFileSync(systemctl, ["is-active", serviceName], { encoding: "utf8" }).trim();
      isActive = stdout === "active";
    } catch (err: any) {
      const stdout = (err.stdout || "").toString().trim();
      const stderr = (err.stderr || "").toString().trim();
      const status = stdout || stderr;
      const normalInactiveStates = ["inactive", "failed", "unknown", "activating", "deactivating"];
      if (normalInactiveStates.includes(status)) {
        isActive = false;
      } else {
        throw new Error(`systemctl is-active failed operationally: ${status || err.message}`);
      }
    }

    if (isActive) {
      serviceWasRunning = true;
      console.log(`[relocate-health-db] Stopping service ${serviceName}...`);
      try {
        execFileSync(systemctl, ["stop", serviceName]);
        updateLedger("service-stopped");
      } catch (err: any) {
        throw new Error(`Failed to stop service ${serviceName} via systemctl: ${err.message}`);
      }
    }

    // Prove the unit is inactive and no database-owning processes remain
    try {
      const state = execFileSync(systemctl, ["is-active", serviceName], { encoding: "utf8" }).trim();
      if (state === "active") {
        throw new Error(`Service ${serviceName} is still active after stop command`);
      }
    } catch (err: any) {
      const stdout = (err.stdout || "").toString().trim();
      const normalInactiveStates = ["inactive", "failed", "unknown"];
      if (!normalInactiveStates.includes(stdout)) {
        throw new Error(`Failed to prove service ${serviceName} is inactive: ${stdout || err.message}`);
      }
    }

    // Prove no database-owning processes remain (using fuser or lsof if available)
    const checkFileNotOpen = (filePath: string) => {
      const fuserBin = "/usr/bin/fuser";
      const lsofBin = "/usr/bin/lsof";
      const checkCmd = (bin: string, args: string[]) => {
        try {
          execFileSync(bin, args, { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      };

      for (const suffix of ["", "-wal", "-shm"]) {
        const targetFile = filePath + suffix;
        if (!existsSync(targetFile)) continue;
        if (existsSync(fuserBin)) {
          if (checkCmd(fuserBin, [targetFile])) {
            throw new Error(`Database file ${targetFile} is held open by an active process`);
          }
        } else if (existsSync(lsofBin)) {
          if (checkCmd(lsofBin, [targetFile])) {
            throw new Error(`Database file ${targetFile} is held open by an active process`);
          }
        }
      }
    };
    checkFileNotOpen(resolvedOldPath);

    // Ensure target directory exists
    mkdirSync(newDir, { recursive: true });

    // Step 2: Capture WAL-safe online backup of old database
    console.log(`[relocate-health-db] Backing up source database: ${resolvedOldPath} -> ${tempBackupPath}`);
    const sourceDb = new Database(resolvedOldPath, { fileMustExist: true });
    try {
      await sourceDb.backup(tempBackupPath);
      updateLedger("backup-created");
    } finally {
      sourceDb.close();
    }

    // Step 3: Validate integrity, foreign keys, schema, and installation provenance on the backup copy
    console.log(`[relocate-health-db] Validating backup copy: ${tempBackupPath}`);
    const backupDb = new Database(tempBackupPath, { fileMustExist: true });
    try {
      const integrity = backupDb.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") {
        throw new Error(`Integrity check failed: ${integrity}`);
      }

      const fk = backupDb.pragma("foreign_key_check");
      if (Array.isArray(fk) && fk.length > 0) {
        throw new Error(`Foreign key check failed: ${JSON.stringify(fk)}`);
      }

      const schemaVersion = Number(backupDb.pragma("user_version", { simple: true }));
      if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
        throw new Error(`Schema version is not current: expected ${CURRENT_SCHEMA_VERSION}, got ${schemaVersion}`);
      }

      const installationId = backupDb.prepare("SELECT value FROM settings WHERE key = 'agent_bridge_installation_id'").get()?.value;
      if (!installationId) {
        throw new Error("Missing installation identity in settings");
      }

      if (expectedInstallationId && installationId !== expectedInstallationId) {
        throw new Error(`Installation identity mismatch in settings: expected "${expectedInstallationId}", got "${installationId}"`);
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

      if (provenance.schemaVersion !== 1) {
        throw new Error(`Unsupported database provenance schema version: ${provenance.schemaVersion}`);
      }

      if (provenance.role !== "health") {
        throw new Error(`Invalid database role in provenance: expected 'health', got '${provenance.role}'`);
      }

      if (provenance.installationId !== installationId) {
        throw new Error(`Provenance installation identity mismatch: settings says "${installationId}", provenance says "${provenance.installationId}"`);
      }

      const resolvedProvenancePath = TEST_ROOT ? join(TEST_ROOT, provenance.path) : provenance.path;
      if (basename(resolvedProvenancePath) !== basename(resolvedOldPath)) {
        throw new Error(`Provenance path mismatch: expected "${basename(resolvedOldPath)}", got "${basename(resolvedProvenancePath)}"`);
      }

      // Step 4: Update provenance path inside the backup database to point to the new location
      console.log(`[relocate-health-db] Updating database provenance path to: ${newPath}`);
      provenance.path = newPath;
      backupDb.prepare("UPDATE settings SET value = ? WHERE key = 'agent_bridge_database_provenance'").run(JSON.stringify(provenance));
      updateLedger("provenance-updated");
    } finally {
      backupDb.close();
    }

    // Step 5: Install database at new path with correct permissions
    console.log(`[relocate-health-db] Installing database at: ${resolvedNewPath}`);
    ensureNotSymlink(resolvedNewPath);
    renameSync(tempBackupPath, resolvedNewPath);
    updateLedger("database-installed");

    chmodSync(resolvedNewPath, 0o600);

    if (!TEST_ROOT && process.getuid?.() === 0 && options.runtimeUser) {
      try {
        execFileSync("/usr/bin/chown", [options.runtimeUser, resolvedNewPath]);
      } catch (err: any) {
        throw new Error(`Failed to set ownership to ${options.runtimeUser}: ${err.message}`);
      }
    }

    // Step 6: Preserve old database for rollback
    console.log(`[relocate-health-db] Preserving old database as backup`);
    ensureNotSymlink(resolvedOldPath);
    renameSync(resolvedOldPath, resolvedOldPath + ".stale-backup");
    updateLedger("old-database-renamed");

    // Step 7: Update env file and rollout inventory configuration
    console.log(`[relocate-health-db] Updating environment file: ${resolvedEnvFilePath}`);
    originalEnvFileContent = readFileSync(resolvedEnvFilePath, "utf8");
    let updatedEnv = originalEnvFileContent;
    if (updatedEnv.includes("HEALTH_DB_PATH=")) {
      updatedEnv = updatedEnv.replace(/^HEALTH_DB_PATH=.*$/m, `HEALTH_DB_PATH=${newPath}`);
    } else {
      updatedEnv += `\nHEALTH_DB_PATH=${newPath}\n`;
    }
    safeWriteFile(resolvedEnvFilePath, updatedEnv);
    updateLedger("env-file-updated");

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
    safeWriteFile(resolvedRolloutConfigPath, updatedRollout);
    updateLedger("rollout-config-updated");

    // Step 8: Restart service with Acceptance Gate
    if (serviceWasRunning && existsSync(systemctl)) {
      // Record baseline NRestarts
      let baselineRestarts = 0;
      try {
        const restartsVal = execFileSync(systemctl, ["show", serviceName, "--property=NRestarts", "--value"], { encoding: "utf8" }).trim();
        baselineRestarts = parseInt(restartsVal, 10) || 0;
      } catch (err) {
        // ignore
      }

      console.log(`[relocate-health-db] Starting service ${serviceName}...`);
      execFileSync(systemctl, ["start", serviceName]);
      updateLedger("service-started");

      // Verify startup health
      let attempts = 0;
      const maxVerifyAttempts = 10;
      let isHealthy = false;
      while (attempts < maxVerifyAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        attempts++;
        try {
          const activeState = execFileSync(systemctl, ["show", serviceName, "--property=ActiveState", "--value"], { encoding: "utf8" }).trim();
          const subState = execFileSync(systemctl, ["show", serviceName, "--property=SubState", "--value"], { encoding: "utf8" }).trim();
          const restartsVal = execFileSync(systemctl, ["show", serviceName, "--property=NRestarts", "--value"], { encoding: "utf8" }).trim();
          const currentRestarts = parseInt(restartsVal, 10) || 0;

          if (currentRestarts > baselineRestarts) {
            throw new Error(`Service crashed and restarted (NRestarts increased from ${baselineRestarts} to ${currentRestarts})`);
          }

          if (activeState === "active" && subState === "running") {
            isHealthy = true;
            break;
          }
          if (activeState === "failed") {
            throw new Error(`Service failed to start (ActiveState is failed)`);
          }
        } catch (err: any) {
          throw new Error(`Service acceptance check failed: ${err.message}`);
        }
      }
      if (!isHealthy) {
        throw new Error(`Service failed to stabilize within active/running state`);
      }
    }

    // Relocation succeeded completely: remove sentinel and ledger files
    rmSync(ledgerFile, { force: true });
    rmSync(sentinelFile, { force: true });
    console.log("[relocate-health-db] Health database relocation completed successfully!");
  } catch (error) {
    await rollback();
    throw error;
  }
}

if (process.argv[1] && (process.argv[1].endsWith("relocate-health-db.ts") || process.argv[1].endsWith("relocate-health-db.js"))) {
  const args = process.argv.slice(2);
  let oldPath = process.env.HEALTH_DB_OLD_PATH || "/home/content-crawler/agent-bridge/.data-health/health.sqlite";
  let newPath = process.env.HEALTH_DB_NEW_PATH || "/home/content-crawler/runtime/agent-bridge/health/health.sqlite";
  let envFilePath = process.env.HEALTH_ENV_FILE_PATH || "/etc/default/agent-bridge-health";
  let rolloutConfigPath = process.env.HEALTH_ROLLOUT_CONFIG_PATH || "/etc/agent-bridge/rollout.conf";
  let serviceName = process.env.HEALTH_SERVICE_NAME || "agent-bridge-health.service";
  let runtimeUser = process.env.HEALTH_RUNTIME_USER || "content-crawler";
  let expectedInstallationId = process.env.AGENT_BRIDGE_INSTALLATION_ID || "";
  let expectedCommit = process.env.HEALTH_EXPECTED_COMMIT || "";
  let authorizationFile = process.env.HEALTH_AUTHORIZATION_FILE || "";
  let authorizationValidatorSha256 = process.env.HEALTH_AUTHORIZATION_VALIDATOR_SHA256 || "";

  while (args.length > 0) {
    const flag = args.shift();
    const val = args.shift();
    if (!val) throw new Error(`Missing value for ${flag}`);
    if (flag === "--old-path") oldPath = val;
    else if (flag === "--new-path") newPath = val;
    else if (flag === "--env-file-path") envFilePath = val;
    else if (flag === "--rollout-config-path") rolloutConfigPath = val;
    else if (flag === "--service-name") serviceName = val;
    else if (flag === "--runtime-user") runtimeUser = val;
    else if (flag === "--expected-installation-id") expectedInstallationId = val;
    else if (flag === "--expected-commit") expectedCommit = val;
    else if (flag === "--authorization-file") authorizationFile = val;
    else if (flag === "--authorization-validator-sha256") authorizationValidatorSha256 = val;
  }

  relocateHealthDb({
    oldPath,
    newPath,
    envFilePath,
    rolloutConfigPath,
    serviceName,
    runtimeUser,
    expectedInstallationId,
    expectedCommit,
    authorizationFile,
    authorizationValidatorSha256,
  }).catch((err) => {
    console.error(`Relocation failed: ${err.message}`);
    process.exit(1);
  });
}
