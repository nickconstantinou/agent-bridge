import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseProvenance } from "../scripts/releaseProvenance.mjs";

describe("historical release provenance", () => {
  it("records identities, hashes, modes, and executable entries", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-provenance-"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "package-lock.json"), "lock\n");
    writeFileSync(join(root, "dist", "index.js"), "#!/usr/bin/env node\n");
    chmodSync(join(root, "dist", "index.js"), 0o755);
    const archive = join(root, "release.tar.gz");
    const members = join(root, "release.tar.gz.members.txt");
    writeFileSync(archive, "archive\n");
    writeFileSync(members, "-rwxr-xr-x root/root dist/index.js\n");

    const provenance = buildReleaseProvenance({
      root,
      targetCommit: "a".repeat(40),
      targetTree: "b".repeat(40),
      builderCommit: "c".repeat(40),
      workflowBlob: "d".repeat(40),
      workflowSha256: "e".repeat(64),
      manifestToolSha256: "f".repeat(64),
      archive,
      archiveMembers: members,
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
    });

    expect(provenance.targetCommit).toBe("a".repeat(40));
    expect(provenance.targetTree).toBe("b".repeat(40));
    expect(provenance.builderCommit).toBe("c".repeat(40));
    expect(provenance.workflowBlob).toBe("d".repeat(40));
    expect(provenance.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.archiveMembersSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.packageLockSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.executableEntries).toEqual([{ path: "dist/index.js", mode: "755" }]);
    expect(provenance.modeInventory).toContainEqual({ path: "dist/index.js", mode: "755" });
    expect(readFileSync(archive, "utf8")).toBe("archive\n");
  });
});
