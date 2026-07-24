import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MEMBER_LINE = /^(\S{10})\s+\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/;

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function permissionDigit(r, w, x) {
  const readBit = r === "-" ? 0 : 4;
  const writeBit = w === "-" ? 0 : 2;
  const execBit = x === "x" || x === "s" || x === "t" ? 1 : 0;
  return readBit + writeBit + execBit;
}

function parseArchiveMembers(archiveMembers) {
  const content = readFileSync(archiveMembers, "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const match = MEMBER_LINE.exec(line);
      if (!match) return [];
      const [, permissions, path] = match;
      if (permissions[0] !== "-") return []; // only regular files
      const mode = [
        permissionDigit(permissions[1], permissions[2], permissions[3]),
        permissionDigit(permissions[4], permissions[5], permissions[6]),
        permissionDigit(permissions[7], permissions[8], permissions[9]),
      ].join("");
      return [{ path, mode }];
    });
}

export function buildReleaseProvenance({
  targetCommit,
  targetTree,
  builderCommit,
  workflowBlob,
  workflowSha256,
  manifestToolSha256,
  manifest,
  archive,
  archiveMembers,
  provenanceTool,
  nodeVersion,
  platform,
  arch,
}) {
  for (const [name, value] of Object.entries({ targetCommit, targetTree, builderCommit, workflowBlob })) {
    if (!SHA.test(value)) throw new Error(`${name} must be a full lowercase Git SHA`);
  }
  for (const [name, value] of Object.entries({ workflowSha256, manifestToolSha256 })) {
    if (!SHA256.test(value)) throw new Error(`${name} must be a full lowercase SHA-256`);
  }

  const manifestData = JSON.parse(readFileSync(manifest, "utf8"));
  const manifestPaths = new Set(manifestData.files.map((file) => file.path));
  const modes = parseArchiveMembers(resolve(archiveMembers));
  const archivePaths = new Set(modes.map(({ path }) => path));

  for (const { path } of modes) {
    if (path === "manifest.json") continue;
    if (!manifestPaths.has(path)) throw new Error(`archive member not present in manifest: ${path}`);
  }
  for (const path of manifestPaths) {
    if (!archivePaths.has(path)) throw new Error(`manifest file not present in archive: ${path}`);
  }

  return {
    schema_version: 1,
    targetCommit,
    targetTree,
    builderCommit,
    workflowBlob,
    workflowSha256,
    manifestToolSha256,
    packageLockSha256: manifestData.package_lock_sha256,
    runtime: { node: nodeVersion, platform, arch },
    archiveSha256: sha256File(archive),
    archiveMembersSha256: sha256File(archiveMembers),
    manifestSha256: sha256File(manifest),
    provenanceToolSha256: sha256File(provenanceTool),
    modeInventory: modes,
    executableEntries: modes.filter(({ mode }) => Number.parseInt(mode, 8) & 0o111),
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const output = argument("--output");
  const required = [
    "--output",
    "--target-commit",
    "--target-tree",
    "--builder-commit",
    "--workflow-blob",
    "--workflow-sha256",
    "--manifest-tool-sha256",
    "--manifest",
    "--archive",
    "--archive-members",
    "--provenance-tool",
  ];
  if (required.some((name) => !argument(name))) throw new Error(`usage: releaseProvenance.mjs ${required.join(" VALUE ")} VALUE`);
  const provenance = buildReleaseProvenance({
    targetCommit: argument("--target-commit"),
    targetTree: argument("--target-tree"),
    builderCommit: argument("--builder-commit"),
    workflowBlob: argument("--workflow-blob"),
    workflowSha256: argument("--workflow-sha256"),
    manifestToolSha256: argument("--manifest-tool-sha256"),
    manifest: argument("--manifest"),
    archive: argument("--archive"),
    archiveMembers: argument("--archive-members"),
    provenanceTool: argument("--provenance-tool"),
    nodeVersion: argument("--node-version") ?? process.version,
    platform: argument("--platform") ?? process.platform,
    arch: argument("--arch") ?? process.arch,
  });
  writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o640 });
}
