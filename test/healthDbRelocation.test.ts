import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    // Mock systemctl script
    writeFileSync(join(testRoot, "bin/systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

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
    })).rejects.toThrow(/Invalid database role in provenance/);

    // Assert rollback: new path empty, configs untouched, old database still exists
    expect(existsSync(resolvedNewPath)).toBe(false);
    expect(existsSync(resolvedOldPath)).toBe(true);
    expect(readFileSync(resolvedEnvFilePath, "utf8")).toBe(originalEnv);
    expect(readFileSync(resolvedRolloutConfigPath, "utf8")).toBe(originalRollout);
  });

  it("rolls back correctly when destination folder write fails or copy is interrupted", async () => {
    seedDb(resolvedOldPath);

    // Make target directory invalid or occupied to trigger a rename/move failure
    // We will do this by pre-creating a folder where the target file should be
    mkdirSync(resolvedNewPath, { recursive: true });

    const originalEnv = readFileSync(resolvedEnvFilePath, "utf8");
    const originalRollout = readFileSync(resolvedRolloutConfigPath, "utf8");

    await expect(relocateHealthDb({
      oldPath,
      newPath,
      envFilePath,
      rolloutConfigPath,
      serviceName,
    })).rejects.toThrow();

    // Verify rollback: configs restored, old database remains intact
    expect(existsSync(resolvedOldPath)).toBe(true);
    expect(readFileSync(resolvedEnvFilePath, "utf8")).toBe(originalEnv);
    expect(readFileSync(resolvedRolloutConfigPath, "utf8")).toBe(originalRollout);
  });
});
