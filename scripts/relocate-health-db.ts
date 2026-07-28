/**
 * PURPOSE: Secure, fail-closed relocation of the health check database to the proper runtime directory.
 * INPUTS: Configurable paths for old db, new db, config files, and testing hooks.
 * OUTPUTS: Explicit WAL-safe backup, verification of schema/integrity/provenance, atomic installation, environment update, and rollback.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync, statSync, lstatSync, realpathSync, openSync, closeSync, fsyncSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { execFileSync, spawn } from "node:child_process";
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
  recover?: boolean;
}

interface LedgerData {
  timestamp: string;
  expectedCommit: string;
  expectedInstallationId: string;
  originalEnvFileContent: string;
  originalRolloutConfigContent: string;
  serviceWasRunning: boolean;
  serviceName: string;
  resolvedOldPath: string;
  resolvedNewPath: string;
  resolvedEnvFilePath: string;
  resolvedRolloutConfigPath: string;
  tempBackupPath: string;
  terminalOutcome?: "relocation-success" | "original-state-restored";
  steps: {
    name: string;
    status: "pending" | "completed";
  }[];
}

function checkFileNotOpen(filePath: string) {
  const TEST_ROOT = process.env.AGENT_BRIDGE_ROLLOUT_TEST_ROOT || "";
  const fuserBin = "/usr/bin/fuser";
  const lsofBin = "/usr/bin/lsof";
  if (!TEST_ROOT && !existsSync(fuserBin) && !existsSync(lsofBin)) {
    throw new Error("Security check failed: neither fuser nor lsof is available on the system");
  }

  for (const suffix of ["", "-wal", "-shm"]) {
    const targetFile = filePath + suffix;
    if (!existsSync(targetFile)) continue;
    if (existsSync(fuserBin)) {
      try {
        execFileSync(fuserBin, [targetFile], { stdio: "ignore" });
        throw new Error(`Database file ${targetFile} is held open by an active process`);
      } catch (err: any) {
        if (err.status !== 1) {
          throw new Error(`fuser inspection failed operationally (exit code ${err.status}): ${err.message}`);
        }
      }
    } else if (existsSync(lsofBin)) {
      try {
        execFileSync(lsofBin, [targetFile], { stdio: "ignore" });
        throw new Error(`Database file ${targetFile} is held open by an active process`);
      } catch (err: any) {
        if (err.status !== 1) {
          throw new Error(`lsof inspection failed operationally (exit code ${err.status}): ${err.message}`);
        }
      }
    }
  }
}

async function restartServiceWithAcceptanceGate(
  systemctl: string, 
  serviceName: string, 
  hasMutations: boolean
): Promise<void> {
  console.log(`[relocate-health-db] Restarting service ${serviceName}...`);

  // Strict non-negative integer parser — rejects empty, negative, partial, non-numeric values
  const parseNRestarts = (raw: string, site: string): number => {
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
      throw new Error(`NRestarts ${site} returned invalid value (expected non-negative integer): '${raw}'`);
    }
    return parseInt(raw, 10);
  };
  
  let baselineRestarts: number;
  try {
    const restartsVal = execFileSync(systemctl, ["show", serviceName, "--property=NRestarts", "--value"], { encoding: "utf8" }).trim();
    baselineRestarts = parseNRestarts(restartsVal, "baseline");
  } catch (err: any) {
    throw new Error(`Service restart acceptance check failed: could not read baseline NRestarts: ${err.message}`);
  }

  execFileSync(systemctl, ["start", serviceName]);

  // Rollback/Recovery Acceptance Gate
  if (hasMutations) {
    let attempts = 0;
    const maxVerifyAttempts = 10;
    let isHealthy = false;
    while (attempts < maxVerifyAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      attempts++;
      try {
        const activeState = execFileSync(systemctl, ["show", serviceName, "--property=ActiveState", "--value"], { encoding: "utf8" }).trim();
        const subState = execFileSync(systemctl, ["show", serviceName, "--property=SubState", "--value"], { encoding: "utf8" }).trim();
        const restartsRaw = execFileSync(systemctl, ["show", serviceName, "--property=NRestarts", "--value"], { encoding: "utf8" }).trim();
        const currentRestarts = parseNRestarts(restartsRaw, "post-start poll");

        if (currentRestarts > baselineRestarts) {
          throw new Error(`Service crashed and restarted (restarts increased)`);
        }

        if (activeState === "active" && subState === "running") {
          isHealthy = true;
          break;
        }
        if (activeState === "failed") {
          throw new Error(`Service failed to start`);
        }
      } catch (err: any) {
        throw new Error(`Service restart acceptance check failed: ${err.message}`);
      }
    }
    if (!isHealthy) {
      throw new Error(`Service failed to stabilize within active/running state during restart`);
    }
  }
}

async function performRecovery(
  ledgerFile: string, 
  sentinelFile: string, 
  systemctl: string, 
  serviceName: string,
  resolvedOldPath: string,
  resolvedNewPath: string,
  resolvedEnvFilePath: string,
  resolvedRolloutConfigPath: string,
  finalExpectedCommit: string,
  expectedInstallationId: string,
  checkLock: () => void
) {
  checkLock();
  if (!existsSync(ledgerFile)) {
    throw new Error(`Sentinel file exists but ledger file is missing at ${ledgerFile}. Inconsistent state, manual recovery required.`);
  }

  // Validate ownership and mode of sentinel and ledger files
  const validateOwnershipAndMode = (filePath: string) => {
    const stat = statSync(filePath);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`File ${filePath} has insecure permissions: ${mode.toString(8)} (expected 0600)`);
    }
    if (typeof process.getuid === "function") {
      if (stat.uid !== process.getuid()) {
        throw new Error(`File ${filePath} is not owned by the current process user (UID: ${process.getuid()}, file UID: ${stat.uid})`);
      }
    }
  };

  validateOwnershipAndMode(sentinelFile);
  validateOwnershipAndMode(ledgerFile);

  const ledgerContent = readFileSync(ledgerFile, "utf8");
  let ledger: LedgerData;
  try {
    ledger = JSON.parse(ledgerContent);
  } catch (err) {
    throw new Error(`Failed to parse ledger file for recovery: ${ledgerFile}`);
  }

  // Ledger Schema Validation
  if (
    !ledger ||
    typeof ledger !== "object" ||
    typeof ledger.expectedCommit !== "string" ||
    typeof ledger.expectedInstallationId !== "string" ||
    typeof ledger.resolvedOldPath !== "string" ||
    typeof ledger.resolvedNewPath !== "string" ||
    typeof ledger.resolvedEnvFilePath !== "string" ||
    typeof ledger.resolvedRolloutConfigPath !== "string" ||
    typeof ledger.tempBackupPath !== "string" ||
    typeof ledger.serviceName !== "string" ||
    !Array.isArray(ledger.steps)
  ) {
    throw new Error("Ledger validation failed: missing or invalid fields in ledger schema");
  }

  // Bind to ledger.expectedCommit and interrupted installation identity
  if (ledger.expectedCommit !== finalExpectedCommit) {
    throw new Error(`Recovery expected commit mismatch: ledger expected commit is ${ledger.expectedCommit}, but current expected commit is ${finalExpectedCommit}`);
  }
  if (ledger.expectedInstallationId !== expectedInstallationId) {
    throw new Error(`Recovery installation identity mismatch: ledger installation ID is ${ledger.expectedInstallationId}, but current expected installation ID is ${expectedInstallationId}`);
  }

  // Canonical Path Comparison
  if (ledger.resolvedOldPath !== resolvedOldPath) {
    throw new Error(`Ledger path mismatch: resolvedOldPath in ledger does not match active resolved path`);
  }
  if (ledger.resolvedNewPath !== resolvedNewPath) {
    throw new Error(`Ledger path mismatch: resolvedNewPath in ledger does not match active resolved path`);
  }
  if (ledger.resolvedEnvFilePath !== resolvedEnvFilePath) {
    throw new Error(`Ledger path mismatch: resolvedEnvFilePath in ledger does not match active resolved path`);
  }
  if (ledger.resolvedRolloutConfigPath !== resolvedRolloutConfigPath) {
    throw new Error(`Ledger path mismatch: resolvedRolloutConfigPath in ledger does not match active resolved path`);
  }
  if (ledger.serviceName !== serviceName) {
    throw new Error(`Ledger service name mismatch: expected ${serviceName}, got ${ledger.serviceName}`);
  }

  // Symlink check on all ledger paths to prevent path traversal
  const ensureNotSymlink = (pathToCheck: string) => {
    try {
      if (existsSync(pathToCheck)) {
        const stat = lstatSync(pathToCheck);
        if (stat.isSymbolicLink()) {
          throw new Error(`Path ${pathToCheck} is a symbolic link, which is forbidden.`);
        }
      }
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

  ensureNotSymlink(ledger.resolvedOldPath);
  ensureNotSymlink(ledger.resolvedNewPath);
  ensureNotSymlink(ledger.resolvedEnvFilePath);
  ensureNotSymlink(ledger.resolvedRolloutConfigPath);
  ensureNotSymlink(ledger.tempBackupPath);

  console.log(`[relocate-health-db] Reverting steps recorded in ledger...`);
  let rollbackSuccess = true;
  let recoveryError: Error | null = null;

  const steps = ledger.steps || [];
  const hasMutations = steps.some(s => 
    (s.status === "completed" || s.status === "pending") && (
      s.name === "database-installed" || 
      s.name === "old-database-renamed" || 
      s.name === "env-file-updated" || 
      s.name === "rollout-config-updated" ||
      s.name === "service-stopped"
    )
  );

  // 1. Quiesce the service first (if running/started)
  if (hasMutations) {
    checkLock();
    if (!existsSync(systemctl)) {
      throw new Error(`systemctl is unavailable at ${systemctl}, cannot prove quiescence for mutation recovery.`);
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
        throw new Error(`Recovery aborted: failed to query service active state: ${status || err.message}`);
      }
    }
    if (isActive) {
      try {
        execFileSync(systemctl, ["stop", serviceName]);
      } catch (err: any) {
        throw new Error(`Recovery aborted: failed to stop active service: ${err.message}`);
      }
    }

    // Prove the unit is inactive
    try {
      const state = execFileSync(systemctl, ["is-active", serviceName], { encoding: "utf8" }).trim();
      const normalInactiveStates = ["inactive", "failed", "unknown"];
      if (!normalInactiveStates.includes(state)) {
        throw new Error(`Recovery aborted: service in active state post-stop: ${state}`);
      }
    } catch (err: any) {
      const stdout = (err.stdout || "").toString().trim();
      const normalInactiveStates = ["inactive", "failed", "unknown"];
      if (!normalInactiveStates.includes(stdout)) {
        throw new Error(`Recovery aborted: failed to prove service is inactive: ${stdout || err.message}`);
      }
    }
    checkLock();
    checkFileNotOpen(resolvedOldPath);
    checkFileNotOpen(resolvedNewPath);
  }

  // Helper: safe atomic write via tmp file
  const safeWriteFile = (targetPath: string, content: string, mode = 0o600) => {
    ensureNotSymlink(targetPath);
    const tmpPath = targetPath + `.tmp-${randomBytes(8).toString("hex")}`;
    writeFileSync(tmpPath, content, { mode });
    
    // durable file fsync
    const fd = openSync(tmpPath, "r+");
    fsyncSync(fd);
    closeSync(fd);
    
    renameSync(tmpPath, targetPath);
 
    // durable directory fsync
    const dirFd = openSync(dirname(targetPath), "r");
    fsyncSync(dirFd);
    closeSync(dirFd);
  };

  // 2. Revert other steps in reverse order
  for (let i = steps.length - 1; i >= 0; i--) {
    checkLock();
    const step = steps[i];
    
    if (step.name === "rollout-config-updated") {
      try {
        safeWriteFile(ledger.resolvedRolloutConfigPath, ledger.originalRolloutConfigContent);
      } catch (err: any) {
        console.error(`Recovery error: failed to restore rollout config: ${err.message}`);
        rollbackSuccess = false;
        recoveryError = err;
      }
    }
    if (step.name === "env-file-updated") {
      try {
        safeWriteFile(ledger.resolvedEnvFilePath, ledger.originalEnvFileContent);
      } catch (err: any) {
        console.error(`Recovery error: failed to restore env file: ${err.message}`);
        rollbackSuccess = false;
        recoveryError = err;
      }
    }
    if (step.name === "old-database-renamed") {
      const staleBackup = ledger.resolvedOldPath + ".stale-backup";
      try {
        if (existsSync(staleBackup) && !existsSync(ledger.resolvedOldPath)) {
          renameSync(staleBackup, ledger.resolvedOldPath);
        }
      } catch (err: any) {
        console.error(`Recovery error: failed to restore old database: ${err.message}`);
        rollbackSuccess = false;
        recoveryError = err;
      }
    }
    if (step.name === "database-installed") {
      try {
        rmSync(ledger.resolvedNewPath, { force: true });
        rmSync(ledger.resolvedNewPath + "-wal", { force: true });
        rmSync(ledger.resolvedNewPath + "-shm", { force: true });
      } catch (err: any) {
        console.error(`Recovery error: failed to clean up new database path: ${err.message}`);
        rollbackSuccess = false;
        recoveryError = err;
      }
    }
    if (step.name === "backup-created") {
      try {
        rmSync(ledger.tempBackupPath, { force: true });
        rmSync(ledger.tempBackupPath + "-wal", { force: true });
        rmSync(ledger.tempBackupPath + "-shm", { force: true });
      } catch (err: any) {
        // ignore best effort
      }
    }
  }

  // 3. Restart original service state if it was running initially, ONLY if restoration was successful
  checkLock();
  if (rollbackSuccess && ledger.serviceWasRunning && existsSync(systemctl)) {
    try {
      await restartServiceWithAcceptanceGate(systemctl, serviceName, hasMutations);
    } catch (err: any) {
      console.error(`Recovery error: failed to restart original service state: ${err.message}`);
      rollbackSuccess = false;
      recoveryError = err;
    }
  }

  if (rollbackSuccess) {
    checkLock();

    ledger.terminalOutcome = "original-state-restored";
    safeWriteFile(ledgerFile, JSON.stringify(ledger, null, 2), 0o600);

    // Durable evidence deletion via rename-then-fsync-then-unlink:
    // 1. Rename both files to .removing names — originals immediately gone from the filesystem namespace.
    //    If this process crashes now, next startup finds no sentinel → won't re-enter recovery.
    const suffix = randomBytes(4).toString("hex");
    const ledgerRemoving = ledgerFile + `.removing-${suffix}`;
    const sentinelRemoving = sentinelFile + `.removing-${suffix}`;
    renameSync(ledgerFile, ledgerRemoving);
    renameSync(sentinelFile, sentinelRemoving);

    // 2. fsync directory — commits that the original names are durably absent.
    const evidenceDir = dirname(ledgerFile);
    const dirFdCommit = openSync(evidenceDir, "r");
    try {
      fsyncSync(dirFdCommit);
    } finally {
      closeSync(dirFdCommit);
    }

    // 3. Unlink the renamed (now unreachable) files. Failures here are best-effort.
    try { rmSync(ledgerRemoving, { force: true }); } catch { /* best-effort */ }
    try { rmSync(sentinelRemoving, { force: true }); } catch { /* best-effort */ }

    // 4. fsync directory again to commit the final unlinks.
    const dirFdFinal = openSync(evidenceDir, "r");
    try {
      fsyncSync(dirFdFinal);
    } catch { /* best-effort — originals are already renamed */ } finally {
      try { closeSync(dirFdFinal); } catch { /* ignore */ }
    }

    checkLock();
    console.log(`[relocate-health-db] Recovery completed successfully and system state restored!`);
  } else {
    throw new Error(`Recovery failed to restore complete original state. Manual inspection required. Reason: ${recoveryError?.message || 'unknown'}`);
  }
}

async function killLockProcess(lockProcess: any): Promise<void> {
  if (!lockProcess) return;
  try {
    lockProcess.kill();
  } catch {
    // ignore
  }
  if (lockProcess.exitCode === null && lockProcess.signalCode === null) {
    await new Promise<void>((resolve) => {
      lockProcess.once("exit", () => resolve());
      setTimeout(resolve, 100);
    });
  }
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

  // Durable Ledger and Sentinel paths under persistent config directory
  const configDir = dirname(resolvedRolloutConfigPath);
  const sentinelFile = join(configDir, ".health-relocation-in-progress");
  const ledgerFile = join(configDir, ".health-relocation-ledger.json");
  const completionFile = join(configDir, ".health-relocation-complete.json");

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
  const safeWriteFile = (targetPath: string, content: string, mode = 0o600) => {
    ensureNotSymlink(targetPath);
    const tmpPath = targetPath + `.tmp-${randomBytes(8).toString("hex")}`;
    writeFileSync(tmpPath, content, { mode });

    // durable file fsync
    const fd = openSync(tmpPath, "r+");
    fsyncSync(fd);
    closeSync(fd);

    renameSync(tmpPath, targetPath);

    // durable directory fsync
    const dirFd = openSync(dirname(targetPath), "r");
    fsyncSync(dirFd);
    closeSync(dirFd);
  };

  // 1. Rollout Lock: spawn flock to hold lock for entire process execution
  const flockBin = "/usr/bin/flock";
  if (!TEST_ROOT && !existsSync(flockBin)) {
    throw new Error("Security check failed: flock binary is not found at /usr/bin/flock");
  }

  let lockProcess: any = null;
  let lockReleased = false;
  if (existsSync(flockBin)) {
    mkdirSync(dirname(lockFile), { recursive: true });
    if (!existsSync(lockFile)) writeFileSync(lockFile, "");
    lockProcess = spawn(flockBin, ["--exclusive", "--nonblock", "--close", lockFile, "sleep", "31536000"]);

    // Ensure it doesn't exit immediately (exit implies lock conflict)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(true);
      }, 100);

      lockProcess.on("exit", (code: number | null) => {
        clearTimeout(timer);
        lockReleased = true;
        reject(new Error(`Another rollout is already active (could not acquire rollout lock: ${lockFile})`));
      });

      lockProcess.on("error", (err: any) => {
        clearTimeout(timer);
        lockReleased = true;
        reject(new Error(`Failed to execute flock: ${err.message}`));
      });
    });

    // Continuous exit monitoring:
    lockProcess.removeAllListeners("exit");
    lockProcess.on("exit", (code: number | null) => {
      lockReleased = true;
      console.error("[relocate-health-db] Lock process terminated unexpectedly!");
    });
  }

  const checkLock = () => {
    if (lockReleased || (lockProcess && lockProcess.exitCode !== null)) {
      throw new Error("Rollout lock was lost or flock process terminated unexpectedly during relocation");
    }
  };

  // Target commit binding and authorization validation
  const isProduction = !TEST_ROOT;
  const finalExpectedCommit = options.expectedCommit || process.env.HEALTH_EXPECTED_COMMIT || "";
  const finalAuthFile = options.authorizationFile || process.env.HEALTH_AUTHORIZATION_FILE || "";
  const finalAuthValidatorSha = options.authorizationValidatorSha256 || process.env.HEALTH_AUTHORIZATION_VALIDATOR_SHA256 || "";

  if (isProduction && (!finalExpectedCommit || !finalAuthFile || !finalAuthValidatorSha)) {
    if (lockProcess) lockProcess.kill();
    throw new Error("Production relocation requires expectedCommit, authorizationFile, and authorizationValidatorSha256 parameters (or environment variables)");
  }

  if (finalExpectedCommit) {
    let gitHead = "";
    try {
      gitHead = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch (err: any) {
      if (lockProcess) lockProcess.kill();
      throw new Error(`Failed to read active git HEAD: ${err.message}`);
    }
    if (gitHead !== finalExpectedCommit) {
      if (lockProcess) lockProcess.kill();
      throw new Error(`Target commit mismatch: active git HEAD is ${gitHead}, expected ${finalExpectedCommit}`);
    }
  }

  if (finalAuthFile) {
    const authValidator = TEST_ROOT 
      ? join(TEST_ROOT, "bin/rollout-authorization-trusted")
      : "/usr/local/libexec/agent-bridge-rollout-authorization.py";
    
    if (!existsSync(authValidator)) {
      if (lockProcess) lockProcess.kill();
      throw new Error(`Rollout authorization validator not found at ${authValidator}`);
    }

    if (finalAuthValidatorSha) {
      const fileBytes = readFileSync(authValidator);
      const sha = createHash("sha256").update(fileBytes).digest("hex");
      if (sha !== finalAuthValidatorSha) {
        if (lockProcess) lockProcess.kill();
        throw new Error(`Authorization validator hash mismatch: expected ${finalAuthValidatorSha}, got ${sha}`);
      }
    }
    
    try {
      execFileSync(authValidator, ["--file", finalAuthFile, "--expected-commit", finalExpectedCommit]);
      console.log(`[relocate-health-db] Rollout authorization verified successfully!`);
    } catch (err: any) {
      if (lockProcess) lockProcess.kill();
      throw new Error(`Rollout authorization validation failed: ${err.message}`);
    }
  }

  const expectedInstallationId = options.expectedInstallationId || process.env.AGENT_BRIDGE_INSTALLATION_ID || "";
  if (isProduction && !expectedInstallationId) {
    if (lockProcess) lockProcess.kill();
    throw new Error("Expected installation ID is required for verification (set AGENT_BRIDGE_INSTALLATION_ID)");
  }

  // Reconcile durable terminal evidence before accepting sentinel absence.
  // A permanent completion record makes successful relocation idempotent; rollback/recovery
  // tombstones are retained until a new normal ledger exists to protect any cleanup retry.
  type RemovingPair = { sentinel: string; ledger: string };
  let pendingRestoredEvidence: RemovingPair | null = null;

  const validateEvidenceFile = (filePath: string, label: string) => {
    const lstat = lstatSync(filePath);
    if (lstat.isSymbolicLink()) {
      throw new Error(`Relocation failed closed: ${label} ${filePath} is a symbolic link. Manual recovery required.`);
    }
    const stat = statSync(filePath);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`Relocation failed closed: ${label} ${filePath} has mode ${mode.toString(8)} (expected 0600). Manual recovery required.`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Relocation failed closed: ${label} ${filePath} is not owned by the current process user. Manual recovery required.`);
    }
  };

  const readTerminalLedger = (filePath: string, label: string): LedgerData => {
    validateEvidenceFile(filePath, label);
    let ledger: LedgerData;
    try {
      ledger = JSON.parse(readFileSync(filePath, "utf8"));
    } catch {
      throw new Error(`Relocation failed closed: unable to parse ${label} ledger ${filePath}. Manual recovery required.`);
    }
    if (
      !ledger ||
      typeof ledger !== "object" ||
      typeof ledger.expectedCommit !== "string" ||
      typeof ledger.expectedInstallationId !== "string" ||
      typeof ledger.originalEnvFileContent !== "string" ||
      typeof ledger.originalRolloutConfigContent !== "string" ||
      typeof ledger.resolvedOldPath !== "string" ||
      typeof ledger.resolvedNewPath !== "string" ||
      typeof ledger.resolvedEnvFilePath !== "string" ||
      typeof ledger.resolvedRolloutConfigPath !== "string" ||
      typeof ledger.serviceName !== "string" ||
      !Array.isArray(ledger.steps)
    ) {
      throw new Error(`Relocation failed closed: ${label} ledger schema validation failed. Manual recovery required.`);
    }
    if (finalExpectedCommit && ledger.expectedCommit !== finalExpectedCommit) {
      throw new Error(`Relocation failed closed: ${label} expected commit mismatch (expected ${finalExpectedCommit}, got ${ledger.expectedCommit}). Manual recovery required.`);
    }
    if (expectedInstallationId && ledger.expectedInstallationId !== expectedInstallationId) {
      throw new Error(`Relocation failed closed: ${label} installation ID mismatch (expected ${expectedInstallationId}, got ${ledger.expectedInstallationId}). Manual recovery required.`);
    }
    if (
      ledger.resolvedOldPath !== resolvedOldPath ||
      ledger.resolvedNewPath !== resolvedNewPath ||
      ledger.resolvedEnvFilePath !== resolvedEnvFilePath ||
      ledger.resolvedRolloutConfigPath !== resolvedRolloutConfigPath
    ) {
      throw new Error(`Relocation failed closed: ${label} path identity mismatch. Manual recovery required.`);
    }
    if (ledger.serviceName !== serviceName) {
      throw new Error(`Relocation failed closed: ${label} service name mismatch. Manual recovery required.`);
    }
    return ledger;
  };

  const validateTerminalState = (ledger: LedgerData, label: string) => {
    const envContent = existsSync(resolvedEnvFilePath) ? readFileSync(resolvedEnvFilePath, "utf8") : null;
    const rolloutContent = existsSync(resolvedRolloutConfigPath) ? readFileSync(resolvedRolloutConfigPath, "utf8") : null;
    const staleBackup = resolvedOldPath + ".stale-backup";

    if (ledger.terminalOutcome === "relocation-success") {
      const successState =
        existsSync(resolvedNewPath) &&
        !existsSync(resolvedOldPath) &&
        existsSync(staleBackup) &&
        envContent !== null && envContent.includes(`HEALTH_DB_PATH=${newPath}`) &&
        rolloutContent !== null && rolloutContent.includes(`database=${newPath}`);
      if (!successState) {
        throw new Error(`Relocation failed closed: ${label} declares relocation-success but live database/configuration state does not match. Manual recovery required.`);
      }
      return;
    }

    if (ledger.terminalOutcome === "original-state-restored") {
      const restoredState =
        existsSync(resolvedOldPath) &&
        !existsSync(resolvedNewPath) &&
        !existsSync(staleBackup) &&
        envContent === ledger.originalEnvFileContent &&
        rolloutContent === ledger.originalRolloutConfigContent;
      if (!restoredState) {
        throw new Error(`Relocation failed closed: ${label} declares original-state-restored but live database/configuration state does not match. Manual recovery required.`);
      }
      return;
    }

    throw new Error(`Relocation failed closed: ${label} has no recognised terminalOutcome. Manual recovery required.`);
  };

  const cleanupEvidence = (paths: string[], label: string) => {
    try {
      for (const path of paths) rmSync(path, { force: true });
      const dirFd = openSync(configDir, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch (err: any) {
      console.error(`[relocate-health-db] Deferred ${label} cleanup: ${err.message}`);
    }
  };

  try {
  if (existsSync(completionFile)) {
    const completedLedger = readTerminalLedger(completionFile, "completion record");
    if (completedLedger.terminalOutcome !== "relocation-success") {
      throw new Error("Relocation failed closed: completion record is not marked relocation-success. Manual recovery required.");
    }
    validateTerminalState(completedLedger, "completion record");
    const residualFiles = existsSync(configDir)
      ? readdirSync(configDir)
          .filter((file) =>
            file === basename(sentinelFile) ||
            file === basename(ledgerFile) ||
            file.startsWith(basename(sentinelFile) + ".removing-") ||
            file.startsWith(basename(ledgerFile) + ".removing-")
          )
          .map((file) => join(configDir, file))
      : [];
    cleanupEvidence(residualFiles, "completed relocation evidence");
    await killLockProcess(lockProcess);
    console.log("[relocate-health-db] Relocation was already completed successfully; no new migration was started.");
    return;
  }

  const files = existsSync(configDir) ? readdirSync(configDir) : [];
  const sentinelPrefix = basename(sentinelFile) + ".removing-";
  const ledgerPrefix = basename(ledgerFile) + ".removing-";
  const sentinelRemovingFiles = files.filter((file) => file.startsWith(sentinelPrefix));
  const ledgerRemovingFiles = files.filter((file) => file.startsWith(ledgerPrefix));
  const suffixes = new Set<string>([
    ...sentinelRemovingFiles.map((file) => file.slice(sentinelPrefix.length)),
    ...ledgerRemovingFiles.map((file) => file.slice(ledgerPrefix.length)),
  ]);

  if (suffixes.size > 1) {
    throw new Error("Relocation failed closed: multiple .removing-* evidence pairs were found. Manual recovery required.");
  }

  if (suffixes.size === 1) {
    const suffix = [...suffixes][0];
    const pair: RemovingPair = {
      sentinel: join(configDir, sentinelPrefix + suffix),
      ledger: join(configDir, ledgerPrefix + suffix),
    };
    if (!existsSync(pair.sentinel) || !existsSync(pair.ledger)) {
      throw new Error("Relocation failed closed: found incomplete or orphaned .removing-* evidence files. Manual recovery required.");
    }
    validateEvidenceFile(pair.sentinel, ".removing-* sentinel");
    const terminalLedger = readTerminalLedger(pair.ledger, ".removing-* evidence");
    validateTerminalState(terminalLedger, ".removing-* evidence");

    if (terminalLedger.terminalOutcome === "relocation-success") {
      safeWriteFile(completionFile, JSON.stringify(terminalLedger, null, 2), 0o600);
      cleanupEvidence([pair.sentinel, pair.ledger], "successful relocation tombstone");
      await killLockProcess(lockProcess);
      console.log("[relocate-health-db] Recovered a completed relocation from durable tombstone evidence; no new migration was started.");
      return;
    }

    pendingRestoredEvidence = pair;
    console.log("[relocate-health-db] Validated restored-state tombstone evidence; a fresh migration may proceed.");
  }

  } catch (err) {
    await killLockProcess(lockProcess);
    throw err;
  }

  // Check if sentinel exists, handle recovery after authorization validation
  const hasSentinel = existsSync(sentinelFile);
  if (hasSentinel && pendingRestoredEvidence) {
    cleanupEvidence([pendingRestoredEvidence.sentinel, pendingRestoredEvidence.ledger], "restored-state tombstone protected by normal evidence");
    pendingRestoredEvidence = null;
  }
  if (hasSentinel) {
    if (options.recover) {
      console.log(`[relocate-health-db] Recovery mode requested. Reconciling previous relocation attempt...`);
      try {
        await performRecovery(
          ledgerFile, 
          sentinelFile, 
          systemctl, 
          serviceName, 
          resolvedOldPath, 
          resolvedNewPath, 
          resolvedEnvFilePath, 
          resolvedRolloutConfigPath,
          finalExpectedCommit,
          expectedInstallationId,
          checkLock
        );
      } finally {
        await killLockProcess(lockProcess);
      }
      return;
    } else {
      if (lockProcess) lockProcess.kill();
      throw new Error(`Relocation sentinel file exists: ${sentinelFile}. A previous relocation attempt may have been interrupted. Run with --recover to reconcile.`);
    }
  }

  // Create sentinel file atomically with 0600 mode
  mkdirSync(dirname(sentinelFile), { recursive: true });
  safeWriteFile(sentinelFile, `${Date.now()}\n`, 0o600);

  // Check if old database exists, support stale-backup recovery
  if (!existsSync(resolvedOldPath)) {
    const staleBackup = resolvedOldPath + ".stale-backup";
    if (existsSync(staleBackup)) {
      console.log(`[relocate-health-db] Source database missing but stale backup exists. Restoring stale backup to recover...`);
      try {
        renameSync(staleBackup, resolvedOldPath);
      } catch (err: any) {
        if (lockProcess) lockProcess.kill();
        rmSync(sentinelFile, { force: true });
        throw new Error(`Failed to restore stale backup: ${err.message}`);
      }
    } else {
      if (lockProcess) lockProcess.kill();
      rmSync(sentinelFile, { force: true });
      throw new Error(`Source database does not exist: ${resolvedOldPath}`);
    }
  }

  // Check if destination database already exists
  if (existsSync(resolvedNewPath)) {
    if (lockProcess) lockProcess.kill();
    rmSync(sentinelFile, { force: true });
    throw new Error(`Destination database already occupied: ${resolvedNewPath}`);
  }

  // Check if config files exist
  if (!existsSync(resolvedEnvFilePath)) {
    if (lockProcess) lockProcess.kill();
    rmSync(sentinelFile, { force: true });
    throw new Error(`Environment file does not exist: ${resolvedEnvFilePath}`);
  }
  if (!existsSync(resolvedRolloutConfigPath)) {
    if (lockProcess) lockProcess.kill();
    rmSync(sentinelFile, { force: true });
    throw new Error(`Rollout config file does not exist: ${resolvedRolloutConfigPath}`);
  }

  // Flags for rollback
  let serviceWasRunning = false;
  const originalEnvFileContent = readFileSync(resolvedEnvFilePath, "utf8");
  const originalRolloutConfigContent = readFileSync(resolvedRolloutConfigPath, "utf8");

  // Initial phase ledger
  const ledgerData: LedgerData = {
    timestamp: new Date().toISOString(),
    expectedCommit: finalExpectedCommit,
    expectedInstallationId: expectedInstallationId,
    originalEnvFileContent,
    originalRolloutConfigContent,
    serviceWasRunning,
    serviceName,
    resolvedOldPath,
    resolvedNewPath,
    resolvedEnvFilePath,
    resolvedRolloutConfigPath,
    tempBackupPath,
    steps: []
  };

  const writeLedger = () => {
    safeWriteFile(ledgerFile, JSON.stringify(ledgerData, null, 2), 0o600);
  };
  writeLedger();
  if (pendingRestoredEvidence) {
    cleanupEvidence([pendingRestoredEvidence.sentinel, pendingRestoredEvidence.ledger], "restored-state tombstone protected by new ledger");
    pendingRestoredEvidence = null;
  }

  const rollback = async () => {
    console.error("[relocate-health-db] Relocation failed. Initiating rollback...");
    let rollbackSuccess = true;

    const rollbackActiveFile = TEST_ROOT ? join(TEST_ROOT, ".rollback-active") : "";
    if (rollbackActiveFile) {
      try {
        writeFileSync(rollbackActiveFile, "true");
      } catch {
        // ignore
      }
    }

    // Read the ledger to know exactly what steps were performed
    let stepsToRollback = ledgerData.steps;
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

    const hasMutations = stepsToRollback.some(s => 
      (s.status === "completed" || s.status === "pending") && (
        s.name === "database-installed" || 
        s.name === "old-database-renamed" || 
        s.name === "env-file-updated" || 
        s.name === "rollout-config-updated" ||
        s.name === "service-stopped"
      )
    );

    if (hasMutations) {
      if (!existsSync(systemctl)) {
        throw new Error(`systemctl is unavailable at ${systemctl}, cannot prove quiescence for mutation rollback.`);
      }
      // 1. Quiesce the service first to avoid mutating active databases!
      checkLock();
      let isServiceActive = false;
      try {
        const stdout = execFileSync(systemctl, ["is-active", serviceName], { encoding: "utf8" }).trim();
        isServiceActive = stdout === "active";
      } catch (err: any) {
        const stdout = (err.stdout || "").toString().trim();
        const stderr = (err.stderr || "").toString().trim();
        const status = stdout || stderr;
        const normalInactiveStates = ["inactive", "failed", "unknown", "activating", "deactivating"];
        if (normalInactiveStates.includes(status)) {
          isServiceActive = false;
        } else {
          throw new Error(`Rollback aborted: failed to query service active state: ${status || err.message}`);
        }
      }
      if (isServiceActive) {
        try {
          console.log(`[relocate-health-db] Stopping active service before restoring files...`);
          execFileSync(systemctl, ["stop", serviceName]);
        } catch (err: any) {
          throw new Error(`Rollback aborted: failed to stop service: ${err.message}`);
        }
      }

      // Prove the unit is inactive
      try {
        const state = execFileSync(systemctl, ["is-active", serviceName], { encoding: "utf8" }).trim();
        const normalInactiveStates = ["inactive", "failed", "unknown"];
        if (!normalInactiveStates.includes(state)) {
          throw new Error(`Rollback aborted: service in active state post-stop: ${state}`);
        }
      } catch (err: any) {
        const stdout = (err.stdout || "").toString().trim();
        const normalInactiveStates = ["inactive", "failed", "unknown"];
        if (!normalInactiveStates.includes(stdout)) {
          throw new Error(`Rollback aborted: failed to prove service is inactive: ${stdout || err.message}`);
        }
      }
    }

    if (hasMutations) {
      checkLock();
      checkFileNotOpen(resolvedOldPath);
      checkFileNotOpen(resolvedNewPath);
    }

    // Revert steps in reverse order
    for (let i = stepsToRollback.length - 1; i >= 0; i--) {
      checkLock();
      const step = stepsToRollback[i];
      if (step.name === "rollout-config-updated") {
        try {
          safeWriteFile(resolvedRolloutConfigPath, originalRolloutConfigContent);
          console.log(`[relocate-health-db] Restored rollout configuration: ${resolvedRolloutConfigPath}`);
        } catch (err: any) {
          console.error(`[relocate-health-db] Failed to restore rollout config: ${err.message}`);
          rollbackSuccess = false;
        }
      }
      if (step.name === "env-file-updated") {
        try {
          safeWriteFile(resolvedEnvFilePath, originalEnvFileContent);
          console.log(`[relocate-health-db] Restored environment file: ${resolvedEnvFilePath}`);
        } catch (err: any) {
          console.error(`[relocate-health-db] Failed to restore env file: ${err.message}`);
          rollbackSuccess = false;
        }
      }
      if (step.name === "old-database-renamed") {
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
      if (step.name === "database-installed") {
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
      if (step.name === "backup-created") {
        try {
          rmSync(tempBackupPath, { force: true });
          rmSync(tempBackupPath + "-wal", { force: true });
          rmSync(tempBackupPath + "-shm", { force: true });
        } catch (err) {
          // ignore best effort
        }
      }
      if (step.name === "service-stopped" && serviceWasRunning && (step.status === "completed" || step.status === "pending") && existsSync(systemctl)) {
        if (rollbackSuccess) {
          checkLock();
          try {
            await restartServiceWithAcceptanceGate(systemctl, serviceName, hasMutations);
          } catch (err: any) {
            console.error(`[relocate-health-db] Failed to restart service during rollback: ${err.message}`);
            rollbackSuccess = false;
          }
        }
      }
    }

    if (rollbackActiveFile) {
      try {
        rmSync(rollbackActiveFile, { force: true });
      } catch {
        // ignore
      }
    }

    if (rollbackSuccess) {
      checkLock();

      const rollbackTerminalLedger: LedgerData = existsSync(ledgerFile)
        ? JSON.parse(readFileSync(ledgerFile, "utf8"))
        : ledgerData;
      rollbackTerminalLedger.terminalOutcome = "original-state-restored";
      safeWriteFile(ledgerFile, JSON.stringify(rollbackTerminalLedger, null, 2), 0o600);

      // Durable evidence deletion via rename-then-fsync-then-unlink:
      // 1. Rename both files to .removing names — originals immediately absent from the namespace.
      const suffix = randomBytes(4).toString("hex");
      const rollbackLedgerRemoving = ledgerFile + `.removing-${suffix}`;
      const rollbackSentinelRemoving = sentinelFile + `.removing-${suffix}`;
      renameSync(ledgerFile, rollbackLedgerRemoving);
      renameSync(sentinelFile, rollbackSentinelRemoving);

      // 2. fsync directory — durably commits that the original names are gone.
      const rollbackEvidenceDir = dirname(ledgerFile);
      const rollbackDirFdCommit = openSync(rollbackEvidenceDir, "r");
      try {
        fsyncSync(rollbackDirFdCommit);
      } finally {
        closeSync(rollbackDirFdCommit);
      }

      // 3. Unlink renamed files (best-effort).
      try { rmSync(rollbackLedgerRemoving, { force: true }); } catch { /* best-effort */ }
      try { rmSync(rollbackSentinelRemoving, { force: true }); } catch { /* best-effort */ }

      // 4. Final fsync (best-effort).
      const rollbackDirFdFinal = openSync(rollbackEvidenceDir, "r");
      try {
        fsyncSync(rollbackDirFdFinal);
      } catch { /* best-effort */ } finally {
        try { closeSync(rollbackDirFdFinal); } catch { /* ignore */ }
      }

      checkLock();
    } else {
      throw new Error("Relocation failed, and rollback restoration failed to restore complete original state. Manual recovery is required.");
    }
  };

  try {
    checkLock();

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
      ledgerData.serviceWasRunning = true;
      writeLedger();

      console.log(`[relocate-health-db] Stopping service ${serviceName}...`);
      try {
        checkLock();
        ledgerData.steps.push({ name: "service-stopped", status: "pending" });
        writeLedger();

        execFileSync(systemctl, ["stop", serviceName]);

        ledgerData.steps[ledgerData.steps.length - 1].status = "completed";
        writeLedger();
      } catch (err: any) {
        throw new Error(`Failed to stop service ${serviceName} via systemctl: ${err.message}`);
      }
    }

    // Prove the unit is inactive
    checkLock();
    try {
      const state = execFileSync(systemctl, ["is-active", serviceName], { encoding: "utf8" }).trim();
      const normalInactiveStates = ["inactive", "failed", "unknown"];
      if (!normalInactiveStates.includes(state)) {
        throw new Error(`Service ${serviceName} is in unsafe state: ${state}`);
      }
    } catch (err: any) {
      const stdout = (err.stdout || "").toString().trim();
      const normalInactiveStates = ["inactive", "failed", "unknown"];
      if (!normalInactiveStates.includes(stdout)) {
        throw new Error(`Failed to prove service ${serviceName} is inactive: ${stdout || err.message}`);
      }
    }

    // Prove no database-owning processes remain
    checkLock();
    checkFileNotOpen(resolvedOldPath);

    // Ensure target directory exists
    mkdirSync(newDir, { recursive: true });

    // Step 2: Capture WAL-safe online backup of old database
    checkLock();
    console.log(`[relocate-health-db] Backing up source database: ${resolvedOldPath} -> ${tempBackupPath}`);
    ledgerData.steps.push({ name: "backup-created", status: "pending" });
    writeLedger();

    const sourceDb = new Database(resolvedOldPath, { fileMustExist: true });
    try {
      await sourceDb.backup(tempBackupPath);
      ledgerData.steps[ledgerData.steps.length - 1].status = "completed";
      writeLedger();
    } finally {
      sourceDb.close();
    }

    // Step 3: Validate integrity, foreign keys, schema, and installation provenance on the backup copy
    checkLock();
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
      if (realpathSync(resolvedProvenancePath) !== realpathSync(resolvedOldPath)) {
        throw new Error(`Provenance path mismatch: expected exact canonical path "${resolvedOldPath}", got "${resolvedProvenancePath}"`);
      }

      // Step 4: Update provenance path inside the backup database to point to the new location
      checkLock();
      console.log(`[relocate-health-db] Updating database provenance path to: ${newPath}`);
      provenance.path = newPath;
      
      ledgerData.steps.push({ name: "provenance-updated", status: "pending" });
      writeLedger();
      
      backupDb.prepare("UPDATE settings SET value = ? WHERE key = 'agent_bridge_database_provenance'").run(JSON.stringify(provenance));
      
      ledgerData.steps[ledgerData.steps.length - 1].status = "completed";
      writeLedger();
    } finally {
      backupDb.close();
    }

    // Step 5: Install database at new path with correct permissions
    checkLock();
    console.log(`[relocate-health-db] Installing database at: ${resolvedNewPath}`);
    ensureNotSymlink(resolvedNewPath);
    
    ledgerData.steps.push({ name: "database-installed", status: "pending" });
    writeLedger();

    renameSync(tempBackupPath, resolvedNewPath);
    
    ledgerData.steps[ledgerData.steps.length - 1].status = "completed";
    writeLedger();

    chmodSync(resolvedNewPath, 0o600);

    if (!TEST_ROOT && process.getuid?.() === 0 && options.runtimeUser) {
      try {
        execFileSync("/usr/bin/chown", [options.runtimeUser, resolvedNewPath]);
      } catch (err: any) {
        throw new Error(`Failed to set ownership to ${options.runtimeUser}: ${err.message}`);
      }
    }

    // Step 6: Preserve old database for rollback
    checkLock();
    console.log(`[relocate-health-db] Preserving old database as backup`);
    ensureNotSymlink(resolvedOldPath);
    
    ledgerData.steps.push({ name: "old-database-renamed", status: "pending" });
    writeLedger();

    renameSync(resolvedOldPath, resolvedOldPath + ".stale-backup");
    
    ledgerData.steps[ledgerData.steps.length - 1].status = "completed";
    writeLedger();

    // Step 7: Update env file and rollout inventory configuration
    checkLock();
    console.log(`[relocate-health-db] Updating environment file: ${resolvedEnvFilePath}`);
    
    ledgerData.steps.push({ name: "env-file-updated", status: "pending" });
    writeLedger();

    let updatedEnv = originalEnvFileContent;
    if (updatedEnv.includes("HEALTH_DB_PATH=")) {
      updatedEnv = updatedEnv.replace(/^HEALTH_DB_PATH=.*$/m, `HEALTH_DB_PATH=${newPath}`);
    } else {
      updatedEnv += `\nHEALTH_DB_PATH=${newPath}\n`;
    }
    safeWriteFile(resolvedEnvFilePath, updatedEnv);
    
    ledgerData.steps[ledgerData.steps.length - 1].status = "completed";
    writeLedger();

    checkLock();
    console.log(`[relocate-health-db] Updating rollout configuration inventory: ${resolvedRolloutConfigPath}`);
    
    ledgerData.steps.push({ name: "rollout-config-updated", status: "pending" });
    writeLedger();

    let updatedRollout = originalRolloutConfigContent;
    const oldConfigDbLine = `database=${oldPath}`;
    const newConfigDbLine = `database=${newPath}`;
    if (updatedRollout.includes(oldConfigDbLine)) {
      updatedRollout = updatedRollout.replace(new RegExp(oldConfigDbLine, "g"), newConfigDbLine);
    } else if (!updatedRollout.includes(newConfigDbLine)) {
      updatedRollout += `\n${newConfigDbLine}\n`;
    }
    safeWriteFile(resolvedRolloutConfigPath, updatedRollout);
    
    ledgerData.steps[ledgerData.steps.length - 1].status = "completed";
    writeLedger();

    // Step 8: Restart service with Acceptance Gate
    if (serviceWasRunning && existsSync(systemctl)) {
      checkLock();
      console.log(`[relocate-health-db] Starting service ${serviceName}...`);
      
      ledgerData.steps.push({ name: "service-started", status: "pending" });
      writeLedger();

      await restartServiceWithAcceptanceGate(systemctl, serviceName, true);
      
      ledgerData.steps[ledgerData.steps.length - 1].status = "completed";
      writeLedger();
    }

    // Relocation succeeded completely. Persist a permanent, identity-bound completion
    // record before attempting best-effort removal of transient ledger/sentinel evidence.
    checkLock();
    ledgerData.terminalOutcome = "relocation-success";
    writeLedger();
    safeWriteFile(completionFile, JSON.stringify(ledgerData, null, 2), 0o600);

    try {
      const suffix = randomBytes(4).toString("hex");
      const successLedgerRemoving = ledgerFile + `.removing-${suffix}`;
      const successSentinelRemoving = sentinelFile + `.removing-${suffix}`;
      renameSync(ledgerFile, successLedgerRemoving);
      renameSync(sentinelFile, successSentinelRemoving);
      const successDirFd = openSync(configDir, "r");
      try { fsyncSync(successDirFd); } finally { closeSync(successDirFd); }
      cleanupEvidence([successLedgerRemoving, successSentinelRemoving], "successful relocation transient evidence");
    } catch (err: any) {
      console.error(`[relocate-health-db] Completion is durable; transient evidence cleanup will be retried: ${err.message}`);
    }

    await killLockProcess(lockProcess);
    console.log("[relocate-health-db] Health database relocation completed successfully!");
  } catch (error) {
    try {
      await rollback();
    } finally {
      await killLockProcess(lockProcess);
    }
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
  let recover = false;

  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--recover") {
      recover = true;
      continue;
    }
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
    recover,
  }).catch((err) => {
    console.error(`Relocation failed: ${err.message}`);
    process.exit(1);
  });
}
