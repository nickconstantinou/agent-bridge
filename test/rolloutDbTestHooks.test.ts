import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupRoots,
  createFixture,
  migrationScript,
  nodeModules,
} from "./support/rolloutFixture";

const tsxCli = join(nodeModules, "tsx", "dist", "cli.mjs");

afterEach(cleanupRoots);

function environmentWithoutTestRoot(extra: Record<string, string>): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...extra };
  delete environment.AGENT_BRIDGE_ROLLOUT_TEST_ROOT;
  return environment;
}

describe("rollout-db migration test-hook boundary", () => {
  it("ignores inherited migration barrier variables without an explicit rollout test root", () => {
    const fixture = createFixture();
    const barrierFile = join(fixture.root, "stray-migration-barrier");
    const result = spawnSync(
      process.execPath,
      [tsxCli, migrationScript, "migrate", "--db", fixture.dbPaths[0]],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: environmentWithoutTestRoot({
          AGENT_BRIDGE_ROLLOUT_TEST_MIGRATE_BARRIER_FILE: barrierFile,
          AGENT_BRIDGE_ROLLOUT_TEST_MIGRATE_PAUSE_AFTER_INDEX: "1",
        }),
      },
    );

    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(barrierFile)).toBe(false);
  });

  it("rejects a migration barrier path outside the explicit rollout test root", () => {
    const fixture = createFixture();
    const barrierFile = join(
      dirname(fixture.root),
      `${basename(fixture.root)}-outside-migration-barrier`,
    );
    rmSync(barrierFile, { force: true });
    try {
      const result = spawnSync(
        process.execPath,
        [tsxCli, migrationScript, "migrate", "--db", fixture.dbPaths[0]],
        {
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
            AGENT_BRIDGE_ROLLOUT_TEST_MIGRATE_BARRIER_FILE: barrierFile,
            AGENT_BRIDGE_ROLLOUT_TEST_MIGRATE_PAUSE_AFTER_INDEX: "1",
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        /migration barrier file must remain inside AGENT_BRIDGE_ROLLOUT_TEST_ROOT/i,
      );
      expect(existsSync(barrierFile)).toBe(false);
    } finally {
      rmSync(barrierFile, { force: true });
    }
  });
});
