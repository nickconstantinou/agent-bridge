import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function modeInventory(root, current = root) {
  return readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const absolute = join(current, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) return modeInventory(root, absolute);
      if (!stat.isFile()) return [];
      const path = relative(root, absolute).split(sep).join("/");
      return [{ path, mode: (stat.mode & 0o7777).toString(8) }];
    });
}

export function buildReleaseProvenance({
  root,
  targetCommit,
  targetTree,
  builderCommit,
  workflowBlob,
  workflowSha256,
  manifestToolSha256,
  archive,
  archiveMembers,
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
  const modes = modeInventory(resolve(root));
  return {
    schema_version: 1,
    targetCommit,
    targetTree,
    builderCommit,
    workflowBlob,
    workflowSha256,
    manifestToolSha256,
    packageLockSha256: sha256File(join(root, "package-lock.json")),
    runtime: { node: nodeVersion, platform, arch },
    archiveSha256: sha256File(archive),
    archiveMembersSha256: sha256File(archiveMembers),
    modeInventory: modes,
    executableEntries: modes.filter(({ mode }) => Number.parseInt(mode, 8) & 0o111),
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const root = argument("--root");
  const output = argument("--output");
  const required = ["--root", "--output", "--target-commit", "--target-tree", "--builder-commit", "--workflow-blob", "--workflow-sha256", "--manifest-tool-sha256", "--archive", "--archive-members"];
  if (required.some((name) => !argument(name))) throw new Error(`usage: releaseProvenance.mjs ${required.join(" VALUE ")} VALUE`);
  const provenance = buildReleaseProvenance({
    root,
    targetCommit: argument("--target-commit"),
    targetTree: argument("--target-tree"),
    builderCommit: argument("--builder-commit"),
    workflowBlob: argument("--workflow-blob"),
    workflowSha256: argument("--workflow-sha256"),
    manifestToolSha256: argument("--manifest-tool-sha256"),
    archive: argument("--archive"),
    archiveMembers: argument("--archive-members"),
    nodeVersion: argument("--node-version") ?? process.version,
    platform: argument("--platform") ?? process.platform,
    arch: argument("--arch") ?? process.arch,
  });
  writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o640 });
}
