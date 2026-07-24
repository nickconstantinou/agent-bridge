import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseProvenance } from "../scripts/releaseProvenance.mjs";

function writeFixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-provenance-"));
  const manifest = join(dir, "manifest.json");
  const archive = join(dir, "release.tar.gz");
  const archiveMembers = join(dir, "release.tar.gz.members.txt");
  const provenanceTool = join(dir, "releaseProvenance.mjs");

  writeFileSync(
    manifest,
    JSON.stringify({
      schema_version: 1,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      package_lock_sha256: "1".repeat(64),
      files: [
        { path: "dist/index.js", sha256: "2".repeat(64), size: 26 },
        { path: "package-lock.json", sha256: "1".repeat(64), size: 5 },
      ],
    }),
  );
  writeFileSync(archive, "archive\n");
  writeFileSync(
    archiveMembers,
    [
      "drwxr-xr-x 0/0             0 2026-07-24 16:41 dist/",
      "-rwxr-xr-x 0/0            26 2026-07-24 16:41 dist/index.js",
      "-rw-r--r-- 0/0             5 2026-07-24 16:41 package-lock.json",
      "-rw-r--r-- 0/0            40 2026-07-24 16:41 manifest.json",
    ].join("\n") + "\n",
  );
  writeFileSync(provenanceTool, "// trusted tool contents\n");

  return {
    targetCommit: "a".repeat(40),
    targetTree: "b".repeat(40),
    builderCommit: "c".repeat(40),
    workflowBlob: "d".repeat(40),
    workflowSha256: "e".repeat(64),
    manifestToolSha256: "f".repeat(64),
    manifest,
    archive,
    archiveMembers,
    provenanceTool,
    nodeVersion: "v24.15.0",
    platform: "linux",
    arch: "x64",
    ...overrides,
  };
}

describe("historical release provenance", () => {
  it("records identities, hashes, modes, and executable entries derived from the archived listing", () => {
    const fixture = writeFixture();

    const provenance = buildReleaseProvenance(fixture);

    expect(provenance.targetCommit).toBe(fixture.targetCommit);
    expect(provenance.targetTree).toBe(fixture.targetTree);
    expect(provenance.builderCommit).toBe(fixture.builderCommit);
    expect(provenance.workflowBlob).toBe(fixture.workflowBlob);
    expect(provenance.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.archiveMembersSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.provenanceToolSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.packageLockSha256).toBe("1".repeat(64));
    expect(provenance.executableEntries).toEqual([{ path: "dist/index.js", mode: "755" }]);
    expect(provenance.modeInventory).toContainEqual({ path: "package-lock.json", mode: "644" });
    expect(provenance.modeInventory).toContainEqual({ path: "manifest.json", mode: "644" });
    expect(provenance.modeInventory.some(({ path }: { path: string }) => path === "dist/")).toBe(false);
  });

  it("rejects a non-SHA identity", () => {
    const fixture = writeFixture({ builderCommit: "not-a-sha" });
    expect(() => buildReleaseProvenance(fixture)).toThrow(/builderCommit must be a full lowercase Git SHA/);
  });

  it("fails closed when the archive contains a file the manifest does not account for", () => {
    const fixture = writeFixture();
    writeFileSync(
      fixture.archiveMembers,
      [
        "-rwxr-xr-x 0/0            26 2026-07-24 16:41 dist/index.js",
        "-rw-r--r-- 0/0             5 2026-07-24 16:41 package-lock.json",
        "-rw-r--r-- 0/0            40 2026-07-24 16:41 manifest.json",
        "-rw-r--r-- 0/0            12 2026-07-24 16:41 dist/unexpected.js",
      ].join("\n") + "\n",
    );

    expect(() => buildReleaseProvenance(fixture)).toThrow(/archive member not present in manifest: dist\/unexpected\.js/);
  });

  it("fails closed when the manifest lists a file missing from the archive", () => {
    const fixture = writeFixture();
    writeFileSync(
      fixture.manifest,
      JSON.stringify({
        schema_version: 1,
        commit: fixture.targetCommit,
        tree: fixture.targetTree,
        package_lock_sha256: "1".repeat(64),
        files: [
          { path: "dist/index.js", sha256: "2".repeat(64), size: 26 },
          { path: "package-lock.json", sha256: "1".repeat(64), size: 5 },
          { path: "dist/missing.js", sha256: "3".repeat(64), size: 9 },
        ],
      }),
    );

    expect(() => buildReleaseProvenance(fixture)).toThrow(/manifest file not present in archive: dist\/missing\.js/);
  });
});
