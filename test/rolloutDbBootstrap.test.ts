import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
// but does so atomically (write to a temp path in the same directory, then
// rename into place) so a mid-migration failure never leaves a partial file
// at the final path.

const migrationScript = fileURLToPath(new URL("../scripts/rollout-db.ts", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rollout-db-bootstrap-"));
  dirs.push(dir);
  return dir;
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
  it("creates a brand-new database at CURRENT_SCHEMA_VERSION", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(["--db", dbPath, "--confirm-new-role", dbPath]);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it("refuses to bootstrap a database that already exists", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    writeFileSync(dbPath, "not a database");
    const res = runBootstrap(["--db", dbPath, "--confirm-new-role", dbPath]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/already exists/i);
    expect(readFileSync(dbPath, "utf8")).toBe("not a database");
  });

  it("requires --confirm-new-role to match the exact target path", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(["--db", dbPath, "--confirm-new-role", join(dir, "other.sqlite")]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/confirm-new-role/i);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses without --confirm-new-role at all", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(["--db", dbPath]);
    expect(res.status).not.toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses when the target path is already occupied by a directory, leaving no temp litter behind", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    mkdirSync(dbPath);
    const res = runBootstrap(["--db", dbPath, "--confirm-new-role", dbPath]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/already exists/i);
    const leftoverEntries = readdirSync(dir).filter((name) => name !== "bridge.sqlite");
    expect(leftoverEntries, `unexpected leftovers: ${leftoverEntries.join(", ")}`).toEqual([]);
  });

  it("leaves no temp litter behind when the atomic rename itself fails (target occupied by a non-empty directory concurrently, after the pre-check but before the rename)", () => {
    // AGENT_BRIDGE_BOOTSTRAP_TEST_PRE_RENAME_OCCUPY is a test-only hook (same
    // pattern as AGENT_BRIDGE_ROLLOUT_TEST_ROOT / FAKE_FAIL_PHASE elsewhere in
    // this test suite): right after the temp database is fully created and
    // migrated, but before the atomic rename, it creates a non-empty directory
    // at the target path so renameSync() itself fails with ENOTEMPTY — proving
    // cleanup runs on a genuine rename failure, not just the existsSync pre-check.
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const res = runBootstrap(
      ["--db", dbPath, "--confirm-new-role", dbPath],
      { AGENT_BRIDGE_BOOTSTRAP_TEST_PRE_RENAME_OCCUPY: dbPath },
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/ENOTEMPTY|not empty|directory/i);
    const leftoverEntries = readdirSync(dir).filter((name) => name !== "bridge.sqlite");
    expect(leftoverEntries, `unexpected leftovers: ${leftoverEntries.join(", ")}`).toEqual([]);
  });

  it("never creates a missing parent directory", () => {
    const dir = tempDir();
    const missingDir = join(dir, "does-not-exist");
    const dbPath = join(missingDir, "bridge.sqlite");
    const res = runBootstrap(["--db", dbPath, "--confirm-new-role", dbPath]);
    expect(res.status).not.toBe(0);
    expect(existsSync(missingDir)).toBe(false);
  });

  it("bootstraps multiple databases in one invocation, each independently", () => {
    const dir = tempDir();
    const first = join(dir, "a.sqlite");
    const second = join(dir, "b.sqlite");
    const res = runBootstrap(["--db", first, "--confirm-new-role", first, "--db", second, "--confirm-new-role", second]);
    expect(res.status, res.stderr).toBe(0);
    for (const path of [first, second]) {
      const db = new Database(path, { readonly: true });
      expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      db.close();
    }
  });

  it("writes evidence when --evidence is provided", () => {
    const dir = tempDir();
    const dbPath = join(dir, "bridge.sqlite");
    const evidencePath = join(dir, "evidence.json");
    const res = runBootstrap(["--db", dbPath, "--confirm-new-role", dbPath, "--evidence", evidencePath]);
    expect(res.status, res.stderr).toBe(0);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    expect(evidence.mode).toBe("bootstrap");
    expect(evidence.databases[0].path).toBe(dbPath);
    expect(evidence.databases[0].schema).toBe("current");
  });
});
