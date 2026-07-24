import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";

const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);

function makeArchive(withExecutable = false): { archive: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-stage-input-"));
  writeFileSync(join(root, "package-lock.json"), "lock\n");
  writeFileSync(join(root, "package.json"), "package\n");
  if (withExecutable) {
    mkdirSync(join(root, "bin"));
    const executable = join(root, "bin", "runtime-entry");
    writeFileSync(executable, "#!/bin/sh\n");
    chmodSync(executable, 0o755);
  }
  const manifest = buildReleaseManifest({
    root,
    commit: COMMIT,
    tree: TREE,
    nodeVersion: "v24.15.0",
    platform: "linux",
    arch: "x64",
  });
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  chmodSync(join(root, "package.json"), 0o644);
  const archive = join(tmpdir(), `agent-bridge-${COMMIT}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", root, "."]);
  return { archive, root };
}

function runStage(archive: string, releaseRoot: string, expectedCommit = COMMIT): string {
  return execFileSync("python3", [
    "scripts/release-stage.py",
    "--archive", archive,
    "--release-root", releaseRoot,
    "--expected-commit", expectedCommit,
  ], {
    encoding: "utf8",
    env: { ...process.env, AGENT_BRIDGE_RELEASE_STAGE_TEST: "1" },
  });
}

describe("immutable release staging", () => {
  it("stages and validates an exact archive into a commit-addressed immutable directory", () => {
    const { archive } = makeArchive();
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));

    const output = runStage(archive, releaseRoot);
    const release = join(releaseRoot, COMMIT);

    expect(output).toMatch(new RegExp(`staged ${COMMIT}`));
    expect(readFileSync(join(release, "package.json"), "utf8")).toBe("package\n");
    expect(statSync(join(release, "package.json")).mode & 0o222).toBe(0);
    expect(statSync(release).mode & 0o222).toBe(0);
  });

  it("preserves executable mode bits for runtime entries", () => {
    const { archive } = makeArchive(true);
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));

    runStage(archive, releaseRoot);

    expect(statSync(join(releaseRoot, COMMIT, "bin", "runtime-entry")).mode & 0o111).toBe(0o111);
  });

  it("is idempotent for an already validated release", () => {
    const { archive } = makeArchive();
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));

    runStage(archive, releaseRoot);
    expect(runStage(archive, releaseRoot)).toMatch(new RegExp(`already staged ${COMMIT}`));
  });

  it("fails closed on an unexpected commit without creating a release", () => {
    const { archive } = makeArchive();
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));
    expect(() => execFileSync("python3", [
      "scripts/release-stage.py", "--archive", archive,
      "--release-root", releaseRoot, "--expected-commit", "3".repeat(40),
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENT_BRIDGE_RELEASE_STAGE_TEST: "1" },
    })).toThrow();

    expect(existsSync(join(releaseRoot, COMMIT))).toBe(false);
  });

  it("rejects a tampered archive before publication", () => {
    const { root } = makeArchive();
    writeFileSync(join(root, "package.json"), "tampered\n");
    const archive = join(tmpdir(), `agent-bridge-tampered-${COMMIT}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", root, "."]);
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));

    expect(() => runStage(archive, releaseRoot)).toThrow();
    expect(existsSync(join(releaseRoot, COMMIT))).toBe(false);
  });

  it("rejects a release root symlink instead of staging outside the configured root", () => {
    const { archive } = makeArchive();
    const parent = mkdtempSync(join(tmpdir(), "agent-bridge-release-root-"));
    const target = mkdtempSync(join(tmpdir(), "agent-bridge-release-target-"));
    const releaseRoot = join(parent, "releases");
    symlinkSync(target, releaseRoot);

    expect(() => runStage(archive, releaseRoot)).toThrow();
    expect(existsSync(join(target, COMMIT))).toBe(false);
  });
});
