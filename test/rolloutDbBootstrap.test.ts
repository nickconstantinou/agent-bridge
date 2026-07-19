import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";

// Issue #135 Phase 4C.3: `rollout-db.ts bootstrap` mode for genuinely missing
// production databases. Distinct from `migrate` (which requires the file to
// already exist): bootstrap creates a brand-new database at exactly
// CURRENT_SCHEMA_VERSION via the same real migration plan every other
// database goes through (reusing openDb()'s existing missing-file path),
// validates it (integrity, foreign keys, exact schema version) before ever
// publishing it, and publishes with atomic no-replace semantics (link() +
// unlink(), not rename()) so a destination that appears concurrently is
// never silently overwritten.

const migrationScript = fileURLToPath(new URL("../scripts/rollout-db.ts", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rollout-db-bootstrap-"));
  dirs.push(dir);
  return dir;
}

function bootstrapArgs(path: string, role = "worker"): string[] {
  return ["--db", path, "--role", role, "--confirm-new-role", path];
}

function runBootstrap(args: string[], env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [tsxCli, migrationScript, "bootstrap", ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("rollout-db.ts bootstrap", () => {
  it("creates a brand-new database at CURRENT_SCHEMA_VERSION and records the role in evidence", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const evidencePath = join(dir, "evidence.json");
    const res = runBootstrap([...bootstrapArgs(dbPath, "worker"), "--evidence", evidencePath]);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence.mode).toBe("bootstrap");
    expect(evidence.databases[0].role).toBe("worker");
    expect(evidence.databases[0].path).toBe(dbPath);
  });

  it("rejects an unrecognized role name", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath, "not-a-real-role"));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/--role/);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses to bootstrap a database that already exists", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    writeFileSync(dbPath, "not a database");
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/already exists/i);
    expect(readFileSync(dbPath, "utf8")).toBe("not a database");
  });

  it("refuses when the destination is a symlink, even a dangling one (existsSync would miss this)", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    symlinkSync(join(dir, "nowhere.sqlite"), dbPath);
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/already exists/i);
  });

  it("requires --confirm-new-role to match the exact target path", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(["--db", dbPath, "--role", "worker", "--confirm-new-role", join(dir, "other.sqlite")]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/confirm-new-role/i);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses without --confirm-new-role at all", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(["--db", dbPath, "--role", "worker"]);
    expect(res.status).not.toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses without --role at all", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(["--db", dbPath, "--confirm-new-role", dbPath]);
    expect(res.status).not.toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses when the parent directory is a symlink", () => {
    const dir = tempDir();
    const realDir = join(dir, "real");
    mkdirSync(realDir);
    const symlinkedDir = join(dir, "linked");
    symlinkSync(realDir, symlinkedDir);
    const dbPath = join(symlinkedDir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/missing or symlinked/i);
    expect(existsSync(join(realDir, "bridge.sqlite"))).toBe(false);
  });

  it("refuses when the parent directory is world-writable", () => {
    const dir = tempDir();
    const unsafeDir = join(dir, "unsafe");
    mkdirSync(unsafeDir, { mode: 0o777 });
    execFileSync("chmod", ["0777", unsafeDir]);
    const dbPath = join(unsafeDir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/writable/i);
  });

  it("refuses when the parent directory is missing, creating nothing", () => {
    const dir = tempDir();
    const missingDir = join(dir, "does-not-exist");
    const dbPath = join(missingDir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(existsSync(missingDir)).toBe(false);
  });

  it("bootstraps multiple role/path pairs in one invocation, each independently", () => {
    const dir = tempDir();
    const first = join(dir, "a.sqlite");
    const second = join(dir, "b.sqlite");
    const res = runBootstrap([...bootstrapArgs(first, "discord"), ...bootstrapArgs(second, "health")]);
    expect(res.status, res.stderr).toBe(0);
    for (const path of [first, second]) {
      const db = new Database(path, { readonly: true });
      expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      db.close();
    }
  });

  it("leaves no temp litter when the target is already occupied by a directory", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    mkdirSync(dbPath);
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/already exists/i);
    const leftoverEntries = readdirSync(dir).filter((name) => name !== "bridge.sqlite");
    expect(leftoverEntries, `unexpected leftovers: ${leftoverEntries.join(", ")}`).toEqual([]);
  });

  it("cleans up the temp database and its WAL/SHM sidecars when migration itself fails", () => {
    // AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_MIGRATION_FAILURE is a test-only hook
    // (same pattern as AGENT_BRIDGE_ROLLOUT_TEST_ROOT / FAKE_FAIL_PHASE
    // elsewhere in this test suite): pre-creates a file at the exact temp
    // path with an unsupported future schema version just before openDb() is
    // called on it, so the existing version-gate in openDb() itself rejects
    // it — a real migration-time failure, not a simulated one — proving
    // cleanup runs and no debris (temp file or its -wal/-shm sidecars, which
    // openDb() creates while enabling WAL mode before its version check can
    // even run for a *pre-existing* file) survives at either path.
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath), { AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_MIGRATION_FAILURE: dbPath });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/unsupported database schema version/i);
    expect(existsSync(dbPath)).toBe(false);
    const leftoverEntries = readdirSync(dir);
    expect(leftoverEntries, `unexpected leftovers: ${leftoverEntries.join(", ")}`).toEqual([]);
  });

  it("cleans up when post-migration validation fails (defense-in-depth: schema version tampered with before publish)", () => {
    // AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_INVALID_SCHEMA is a test-only hook:
    // after openDb() successfully migrates the temp database to
    // CURRENT_SCHEMA_VERSION, directly rewrites its user_version to an
    // unexpected value before validateBootstrapped() runs — proving the
    // pre-publication validation step actually gates publication, not just
    // trusting that migration succeeded.
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath), { AGENT_BRIDGE_BOOTSTRAP_TEST_FORCE_INVALID_SCHEMA: dbPath });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/did not reach CURRENT_SCHEMA_VERSION/i);
    expect(existsSync(dbPath)).toBe(false);
    const leftoverEntries = readdirSync(dir);
    expect(leftoverEntries, `unexpected leftovers: ${leftoverEntries.join(", ")}`).toEqual([]);
  });

  it("refuses to overwrite a destination that appears concurrently between validation and publication (atomic no-replace)", () => {
    // AGENT_BRIDGE_BOOTSTRAP_TEST_PRE_PUBLISH_OCCUPY is a test-only hook:
    // right after the temp database passes pre-publication validation, but
    // before the atomic link()-based publish, it writes a file at the final
    // target path — simulating a genuine race with a concurrent writer.
    // link() must fail with EEXIST rather than the publish silently
    // replacing the concurrently-created content.
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath), { AGENT_BRIDGE_BOOTSTRAP_TEST_PRE_PUBLISH_OCCUPY: dbPath });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/concurrently/i);
    expect(readFileSync(dbPath, "utf8")).toBe("concurrently created by a different process\n");
    const leftoverEntries = readdirSync(dir).filter((name) => name !== "bridge.sqlite");
    expect(leftoverEntries, `unexpected leftovers: ${leftoverEntries.join(", ")}`).toEqual([]);
  });

  it("never creates a missing parent directory", () => {
    const dir = tempDir();
    const missingDir = join(dir, "does-not-exist");
    const dbPath = join(missingDir, "bridge.sqlite");
    const res = runBootstrap(bootstrapArgs(dbPath));
    expect(res.status).not.toBe(0);
    expect(existsSync(missingDir)).toBe(false);
  });

  it("writes evidence with role, path, and current-schema evidence when --evidence is provided", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const evidencePath = join(dir, "evidence.json");
    const res = runBootstrap([...bootstrapArgs(dbPath, "health"), "--evidence", evidencePath]);
    expect(res.status, res.stderr).toBe(0);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence.mode).toBe("bootstrap");
    expect(evidence.databases[0]).toMatchObject({
      path: dbPath,
      role: "health",
      schema: "current",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      integrity: "ok",
    });
  });
});

describe("rollout-db.ts ordinary modes never bootstrap", () => {
  it("inspect never creates a missing database", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    try {
      execFileSync(process.execPath, [tsxCli, migrationScript, "inspect", "--db", dbPath], { encoding: "utf8" });
      expect.fail("expected inspect to fail on a missing database");
    } catch (err: any) {
      expect(err.status).not.toBe(0);
    }
    expect(existsSync(dbPath)).toBe(false);
  });

  it("validate never creates a missing database", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    try {
      execFileSync(process.execPath, [tsxCli, migrationScript, "validate", "--db", dbPath], { encoding: "utf8" });
      expect.fail("expected validate to fail on a missing database");
    } catch (err: any) {
      expect(err.status).not.toBe(0);
    }
    expect(existsSync(dbPath)).toBe(false);
  });

  it("an unrecognized mode string is rejected by the usage check, never silently routed to bootstrap logic", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    try {
      execFileSync(process.execPath, [tsxCli, migrationScript, "bootstrapp", "--db", dbPath, "--role", "worker", "--confirm-new-role", dbPath], { encoding: "utf8" });
      expect.fail("expected an unrecognized mode to fail");
    } catch (err: any) {
      expect(err.status).not.toBe(0);
      expect(err.stderr).toMatch(/usage/i);
    }
    expect(existsSync(dbPath)).toBe(false);
  });
});
