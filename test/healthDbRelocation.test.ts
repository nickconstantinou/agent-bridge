import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { relocateHealthDb } from "../scripts/relocate-health-db.js";
import { openDb } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";

const testRoot = mkdtempSync(join(tmpdir(), "health-db-relocate-test-"));

describe("Health check database relocation", () => {
  const oldPath = "data-health/health.sqlite";
  const newPath = "runtime/health/health.sqlite";
  const envFilePath = "etc/default/agent-bridge-health";
  const rolloutConfigPath = "etc/agent-bridge/rollout.conf";
  const serviceName = "agent-bridge-health.service";

  const resolvedOldPath = join(testRoot, oldPath);
  const resolvedNewPath = join(testRoot, newPath);
  const resolvedEnvFilePath = join(testRoot, envFilePath);
  const resolvedRolloutConfigPath = join(testRoot, rolloutConfigPath);

  beforeEach(() => {
    // Reset test environment variable for the script
    process.env.AGENT_BRIDGE_ROLLOUT_TEST_ROOT = testRoot;

    // Create directories
    mkdirSync(join(testRoot, "data-health"), { recursive: true });
    mkdirSync(join(testRoot, "etc/default"), { recursive: true });
    mkdirSync(join(testRoot, "etc/agent-bridge"), { recursive: true });
    mkdirSync(join(testRoot, "bin"), { recursive: true });
    mkdirSync(join(testRoot, "run/agent-bridge"), { recursive: true });
    mkdirSync(join(testRoot, "run/lock"), { recursive: true });

    // Mock systemctl script (default: inactive, exits 3 on is-active)
    writeFileSync(join(testRoot, "bin/systemctl"), `#!/bin/sh
if [ "$1" = "is-active" ]; then
  echo "inactive"
  exit 3
fi
exit 0
`, { mode: 0o755 });

    // Write dummy config files
    writeFileSync(resolvedEnvFilePath, "HEALTH_DB_PATH=data-health/health.sqlite\nBRIDGE_EXECUTION_MODE=trusted\n");
    writeFileSync(resolvedRolloutConfigPath, `project_dir=${testRoot}\ndatabase=data-health/health.sqlite\n`);
  });

  afterEach(() => {
    delete process.env.AGENT_BRIDGE_ROLLOUT_TEST_ROOT;
    rmSync(testRoot, { recursive: true, force: true });
  });

  function seedDb(path: string, options: { userVersion?: number; role?: string; installationId?: string; pathOverride?: string } = {}) {
    const role = options.role ?? "health";
    const installationId = options.installationId ?? "test-install-id-123";
    const userVersion = options.userVersion ?? CURRENT_SCHEMA_VERSION;
    const dbPath = options.pathOverride ?? oldPath;

    // 1. Create a structurally valid openDb database
    const db = openDb(path, { serviceId: "test:seed" });
    db.close();

    // 2. Set user_version and settings
    const raw = new Database(path);
    raw.exec(`PRAGMA user_version = ${userVersion};`);
    raw.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
      "agent_bridge_installation_id",
      installationId
    );
    raw.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
      "agent_bridge_database_provenance",
      JSON.stringify({
        schemaVersion: 1,
        source: "fresh-install",
        role,
        path: dbPath,
        installationId,
        createdAt: new Date().toISOString(),
      })
    );
    raw.close();
  }

  it("relocates database successfully and updates configs when database is valid", async () => {
    seedDb(resolvedOldPath);

    await relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    });

    // Check new database exists and is valid
    expect(existsSync(resolvedNewPath)).toBe(true);
    
    // Check old database is archived
    expect(existsSync(resolvedOldPath)).toBe(false);
    expect(existsSync(resolvedOldPath + ".stale-backup")).toBe(true);

    // Verify updated provenance path inside the database
    const db = new Database(resolvedNewPath);
    const provenanceText = db.prepare("SELECT value FROM settings WHERE key = 'agent_bridge_database_provenance'").get().value;
    const provenance = JSON.parse(provenanceText);
    expect(provenance.path).toBe(newPath);
    db.close();

    // Verify updated configs
    const envContent = readFileSync(resolvedEnvFilePath, "utf8");
    expect(envContent).toContain(`HEALTH_DB_PATH=${newPath}`);

    const rolloutContent = readFileSync(resolvedRolloutConfigPath, "utf8");
    expect(rolloutContent).toContain(`database=${newPath}`);
  });

  it("fails and rolls back when the source database is missing", async () => {
    const originalEnv = readFileSync(resolvedEnvFilePath, "utf8");
    const originalRollout = readFileSync(resolvedRolloutConfigPath, "utf8");

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/Source database does not exist/);

    expect(existsSync(resolvedNewPath)).toBe(false);
    expect(readFileSync(resolvedEnvFilePath, "utf8")).toBe(originalEnv);
    expect(readFileSync(resolvedRolloutConfigPath, "utf8")).toBe(originalRollout);
  });

  it("fails and rolls back when database schema version is invalid", async () => {
    // Seed with invalid user_version
    seedDb(resolvedOldPath, { userVersion: 999 });

    const originalEnv = readFileSync(resolvedEnvFilePath, "utf8");
    const originalRollout = readFileSync(resolvedRolloutConfigPath, "utf8");

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/Schema version is not current/);

    // Assert rollback: new path empty, configs untouched, old database still exists
    expect(existsSync(resolvedNewPath)).toBe(false);
    expect(existsSync(resolvedOldPath)).toBe(true);
    expect(readFileSync(resolvedEnvFilePath, "utf8")).toBe(originalEnv);
    expect(readFileSync(resolvedRolloutConfigPath, "utf8")).toBe(originalRollout);
  });

  it("fails and rolls back when provenance validation fails", async () => {
    // Seed with incorrect database role in provenance
    seedDb(resolvedOldPath, { role: "worker" });

    const originalEnv = readFileSync(resolvedEnvFilePath, "utf8");
    const originalRollout = readFileSync(resolvedRolloutConfigPath, "utf8");

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/Invalid database role in provenance/);

    // Assert rollback: new path empty, configs untouched, old database still exists
    expect(existsSync(resolvedNewPath)).toBe(false);
    expect(existsSync(resolvedOldPath)).toBe(true);
    expect(readFileSync(resolvedEnvFilePath, "utf8")).toBe(originalEnv);
    expect(readFileSync(resolvedRolloutConfigPath, "utf8")).toBe(originalRollout);
  });

  // REGRESSIONS:

  it("exercises active service stop and confirms quiescence", async () => {
    // Write systemctl mock that simulates an active service that can be stopped
    writeFileSync(join(testRoot, "bin/systemctl"), `#!/bin/sh
if [ "$1" = "is-active" ]; then
  if [ -f "${testRoot}/.service-started" ]; then
    echo "active"
    exit 0
  elif [ -f "${testRoot}/.service-stopped" ]; then
    echo "inactive"
    exit 3
  else
    echo "active"
    exit 0
  fi
elif [ "$1" = "stop" ]; then
  touch "${testRoot}/.service-stopped"
  rm -f "${testRoot}/.service-started"
  exit 0
elif [ "$1" = "start" ]; then
  touch "${testRoot}/.service-started"
  exit 0
elif [ "$1" = "show" ]; then
  if [ -f "${testRoot}/.service-started" ]; then
    if echo "$*" | grep -q "ActiveState"; then
      echo "active"
    elif echo "$*" | grep -q "SubState"; then
      echo "running"
    elif echo "$*" | grep -q "NRestarts"; then
      echo "0"
    fi
  else
    if echo "$*" | grep -q "ActiveState"; then
      echo "inactive"
    elif echo "$*" | grep -q "SubState"; then
      echo "dead"
    elif echo "$*" | grep -q "NRestarts"; then
      echo "0"
    fi
  fi
  exit 0
fi
exit 0
`, { mode: 0o755 });

    seedDb(resolvedOldPath);

    await relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    });

    expect(existsSync(join(testRoot, ".service-stopped"))).toBe(true);
    expect(existsSync(resolvedNewPath)).toBe(true);
  });

  it("fails and rolls back on stop failure", async () => {
    writeFileSync(join(testRoot, "bin/systemctl"), `#!/bin/sh
if [ "$1" = "is-active" ]; then
  echo "active"
  exit 0
elif [ "$1" = "stop" ]; then
  echo "stop failed fatally" >&2
  exit 1
fi
`, { mode: 0o755 });

    seedDb(resolvedOldPath);

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/Failed to stop service/);

    expect(existsSync(resolvedNewPath)).toBe(false);
    expect(existsSync(resolvedOldPath)).toBe(true);
  });

  it("fails and rolls back on restart failure or failed acceptance gate", async () => {
    writeFileSync(join(testRoot, "bin/systemctl"), `#!/bin/sh
if [ "$1" = "is-active" ]; then
  if [ -f "${testRoot}/.service-started" ]; then
    echo "active"
    exit 0
  elif [ -f "${testRoot}/.service-stopped" ]; then
    echo "inactive"
    exit 3
  else
    echo "active"
    exit 0
  fi
elif [ "$1" = "stop" ]; then
  touch "${testRoot}/.service-stopped"
  rm -f "${testRoot}/.service-started"
  exit 0
elif [ "$1" = "start" ]; then
  touch "${testRoot}/.service-started"
  exit 0
elif [ "$1" = "show" ]; then
  if echo "$*" | grep -q "NRestarts"; then
    if [ -f "${testRoot}/.rollback-active" ]; then
      echo "0"
    elif [ -f "${testRoot}/.service-started" ]; then
      echo "5"
    else
      echo "0"
    fi
  elif echo "$*" | grep -q "ActiveState"; then
    echo "active"
  elif echo "$*" | grep -q "SubState"; then
    echo "running"
  fi
  exit 0
fi
exit 0
`, { mode: 0o755 });

    seedDb(resolvedOldPath);

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/Service crashed and restarted/);

    expect(existsSync(resolvedNewPath)).toBe(false);
    expect(existsSync(resolvedOldPath)).toBe(true);
  });

  it("detects concurrent writer holding database file open", async () => {
    seedDb(resolvedOldPath);

    // Keep database open using node:fs openSync
    const fd = openSync(resolvedOldPath, "r+");

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/is held open by an active process/);

    closeSync(fd);
    expect(existsSync(resolvedNewPath)).toBe(false);
  });

  it("fails when settings installation ID has identity mismatch", async () => {
    seedDb(resolvedOldPath, { installationId: "wrong-identity" });

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "expected-identity-123",
    })).rejects.toThrow(/Installation identity mismatch/);
  });

  it("fails when provenance installation ID doesn't match settings ID", async () => {
    // Modify settings manually to create a mismatch between settings and provenance JSON
    seedDb(resolvedOldPath, { installationId: "test-install-id-123" });
    const raw = new Database(resolvedOldPath);
    raw.prepare("UPDATE settings SET value = 'mismatched-id' WHERE key = 'agent_bridge_installation_id'").run();
    raw.close();

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "mismatched-id",
    })).rejects.toThrow(/Provenance installation identity mismatch/);
  });

  it("rejects symbolic links on source, destination or config files", async () => {
    seedDb(resolvedOldPath);

    // Make envFilePath a symlink
    rmSync(resolvedEnvFilePath);
    symlinkSync(resolvedOldPath, resolvedEnvFilePath);

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/is a symbolic link, which is forbidden/);
  });

  it("fails when configuration files are missing", async () => {
    seedDb(resolvedOldPath);
    rmSync(resolvedEnvFilePath);

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/Environment file does not exist/);
  });

  it("prevents execution if relocation sentinel is present (interrupted state)", async () => {
    seedDb(resolvedOldPath);

    // Create sentinel file
    const sentinelFile = join(testRoot, "etc/agent-bridge/.health-relocation-in-progress");
    writeFileSync(sentinelFile, "123456\n");

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/Relocation sentinel file exists/);
  });

  // NEW REGRESSIONS:

  it("detects concurrent writer holding WAL sidecar file open", async () => {
    seedDb(resolvedOldPath);
    // Create a dummy -wal file
    const walFile = resolvedOldPath + "-wal";
    writeFileSync(walFile, "wal-content");

    // Keep WAL file open using node:fs openSync
    const fd = openSync(walFile, "r+");

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/is held open by an active process/);

    closeSync(fd);
    rmSync(walFile);
  });

  it("fails when systemctl is-active returns an operational failure", async () => {
    writeFileSync(join(testRoot, "bin/systemctl"), `#!/bin/sh
echo "systemd: bus connection failed" >&2
exit 1
`, { mode: 0o755 });

    seedDb(resolvedOldPath);

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/systemctl is-active failed operationally/);
  });

  it("fails when systemctl is absent", async () => {
    seedDb(resolvedOldPath);
    // Remove the mocked systemctl
    rmSync(join(testRoot, "bin/systemctl"));

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/systemctl binary not found/);
  });

  it("rejects symlinked destination ancestors", async () => {
    seedDb(resolvedOldPath);

    // Create a symlinked directory in the destination path
    // resolvedNewPath is: testRoot/runtime/health/health.sqlite
    // Let's make "testRoot/runtime/health" a symlink to another directory
    const realDestDir = join(testRoot, "real-dest");
    mkdirSync(realDestDir, { recursive: true });
    
    mkdirSync(join(testRoot, "runtime"), { recursive: true });
    symlinkSync(realDestDir, join(testRoot, "runtime/health"));

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    })).rejects.toThrow(/Ancestor directory .* is a symbolic link, which is forbidden/);
  });

  it("prevents execution if another rollout holds the lock", async () => {
    seedDb(resolvedOldPath);

    // Acquire the lock in a background process using flock
    const lockFile = join(testRoot, "run/lock/agent-bridge-rollout.lock");
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, "");

    // Spawn a background process that holds the lock
    const flockProcess = spawn("/usr/bin/flock", ["--exclusive", lockFile, "sleep", "10"]);

    // Give it a short moment to start and acquire the lock
    await new Promise((resolve) => setTimeout(resolve, 200));

    try {
      await expect(relocateHealthDb({
        oldPath,
        newPath,
        envFilePath,
        rolloutConfigPath,
        serviceName,
        expectedInstallationId: "test-install-id-123",
      })).rejects.toThrow(/Another rollout is already active/);
    } finally {
      flockProcess.kill();
    }
  });

  it("fails when authorization validator SHA-256 hash mismatch occurs", async () => {
    seedDb(resolvedOldPath);

    // Create a mock validator
    const authValidator = join(testRoot, "bin/rollout-authorization-trusted");
    writeFileSync(authValidator, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // The SHA of this mock validator is different from the expected pin
    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
      authorizationFile: "some-auth-file",
      authorizationValidatorSha256: "wrong-sha-hash",
    })).rejects.toThrow(/Authorization validator hash mismatch/);
  });

  it("recovers from an existing .stale-backup if source database is missing", async () => {
    // Seed the stale backup, but make the source database missing
    const staleBackupPath = resolvedOldPath + ".stale-backup";
    seedDb(staleBackupPath);

    // Make sure old path does not exist
    expect(existsSync(resolvedOldPath)).toBe(false);

    await relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
    });

    // It should have successfully relocated the database using the stale backup!
    expect(existsSync(resolvedNewPath)).toBe(true);
    expect(existsSync(staleBackupPath)).toBe(true); // it renamed stale backup to oldPath, then did the relocation which renamed it back to stale-backup!
  });

  it("reconciles and recovers using the ledger in recovery mode", async () => {
    seedDb(resolvedOldPath);

    // Save the original files content
    const originalEnvContent = readFileSync(resolvedEnvFilePath, "utf8");
    const originalRolloutContent = readFileSync(resolvedRolloutConfigPath, "utf8");

    // Simulate an interrupted migration by writing a partial state
    // Let's say we got up to "old-database-renamed"
    seedDb(resolvedNewPath);
    renameSync(resolvedOldPath, resolvedOldPath + ".stale-backup");

    // Write a ledger file next to rollout.conf (resolved as testRoot/etc/agent-bridge/.health-relocation-ledger.json)
    const ledgerFile = join(testRoot, "etc/agent-bridge/.health-relocation-ledger.json");
    const sentinelFile = join(testRoot, "etc/agent-bridge/.health-relocation-in-progress");

    writeFileSync(sentinelFile, "123456\n");
    writeFileSync(ledgerFile, JSON.stringify({
      timestamp: new Date().toISOString(),
      expectedCommit: "",
      originalEnvFileContent: originalEnvContent,
      originalRolloutConfigContent: originalRolloutContent,
      serviceWasRunning: true,
      resolvedOldPath,
      resolvedNewPath,
      resolvedEnvFilePath,
      resolvedRolloutConfigPath,
      tempBackupPath: join(testRoot, "runtime/health/.relocate-backup-test"),
      steps: [
        { name: "service-stopped", status: "completed" },
        { name: "backup-created", status: "completed" },
        { name: "database-installed", status: "completed" },
        { name: "old-database-renamed", status: "completed" }
      ]
    }, null, 2));

    // Mock systemctl to see that start is called
    writeFileSync(join(testRoot, "bin/systemctl"), `#!/bin/sh
if [ "$1" = "is-active" ]; then
  echo "inactive"
  exit 3
elif [ "$1" = "start" ]; then
  exit 0
elif [ "$1" = "show" ]; then
  if echo "$*" | grep -q "ActiveState"; then
    echo "active"
  elif echo "$*" | grep -q "SubState"; then
    echo "running"
  elif echo "$*" | grep -q "NRestarts"; then
    echo "0"
  fi
  exit 0
fi
`, { mode: 0o755 });

    // Rerun relocation in recover mode
    await relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
      expectedInstallationId: "test-install-id-123",
      recover: true
    });

    // Verify recovery restored original files and cleaned up new files
    expect(existsSync(resolvedOldPath)).toBe(true);
    expect(existsSync(resolvedNewPath)).toBe(false);
    expect(existsSync(resolvedOldPath + ".stale-backup")).toBe(false);
    expect(existsSync(sentinelFile)).toBe(false);
    expect(existsSync(ledgerFile)).toBe(false);
  });
});
