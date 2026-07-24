import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";

describe("release artifact manifest", () => {
  it("binds the artifact to its commit, tree, lockfile and deterministic file hashes", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.js"), "console.log('release');\n");
    writeFileSync(join(root, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
    writeFileSync(join(root, "package.json"), "{\"name\": \"agent-bridge\"}\n");

    const manifest = buildReleaseManifest({
      root,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
    });

    expect(manifest.schema_version).toBe(1);
    expect(manifest.commit).toBe("a".repeat(40));
    expect(manifest.tree).toBe("b".repeat(40));
    expect(manifest.package_lock_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([
      "dist/index.js",
      "package-lock.json",
      "package.json",
    ]);
    expect(manifest.files.every((file: { sha256: string; size: number }) =>
      /^[0-9a-f]{64}$/.test(file.sha256) && file.size > 0
    )).toBe(true);
  });

  it("does not include the manifest itself or files outside the artifact root", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-"));
    writeFileSync(join(root, "package-lock.json"), "lock\n");
    writeFileSync(join(root, "manifest.json"), "stale\n");

    const manifest = buildReleaseManifest({
      root,
      commit: "c".repeat(40),
      tree: "d".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
    });

    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(["package-lock.json"]);
    expect(manifest.files.some((file: { path: string }) => file.path.includes(".."))).toBe(false);
  });

  it("rejects symlinks that escape the artifact root", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-"));
    writeFileSync(join(root, "package-lock.json"), "lock\n");
    symlinkSync("/etc/passwd", join(root, "escaped"));

    expect(() => buildReleaseManifest({
      root,
      commit: "e".repeat(40),
      tree: "f".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
    })).toThrow(/escaped root/);
  });

  it("uses the exact event head for artifact naming and portable checksum output", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/release-artifact.yml"), "utf8");

    expect(workflow).toContain("name: agent-bridge-release-${{ github.event.pull_request.head.sha || github.sha }}");
    expect(workflow).toContain('( cd "$(dirname "$archive")" && sha256sum "$(basename "$archive")" )');
  });

  it("packages the source entrypoints and guarded migration scripts required by the service contract", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/release-artifact.yml"), "utf8");

    expect(workflow).toContain("cp -a dist src scripts/rollout-db.ts scripts/rollout-db-impl.ts package.json package-lock.json node_modules");
    for (const entrypoint of [
      "src/index.ts",
      "src/index-interactive.ts",
      "src/index-discord-interactive.ts",
      "src/index-health.ts",
      "src/index-worker.ts",
      "scripts/rollout-db.ts",
      "scripts/rollout-db-impl.ts",
    ]) {
      expect(readFileSync(join(process.cwd(), entrypoint), "utf8")).not.toHaveLength(0);
    }
  });

  it("defines the historical two-identity artifact builder as read-only CI", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");

    expect(workflow).toContain("target_commit:");
    expect(workflow).toContain("expected_tree:");
    expect(workflow).toContain("builder_commit:");
    expect(workflow).toContain("path: trusted-builder");
    expect(workflow).toContain("path: target-source");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("releaseProvenance.mjs");
    expect(workflow).toContain("archive.members.txt");
    expect(workflow).not.toContain("secrets.");
  });
});
