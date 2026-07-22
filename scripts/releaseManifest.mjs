import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";

const SHA256 = /^[0-9a-f]{40}$/;

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function collectFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const absolute = join(current, entry.name);
      if (entry.name === "manifest.json" && current === root) return [];
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        const resolvedTarget = resolve(current, target);
        if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`)) {
          throw new Error(`release artifact symlink escaped root: ${absolute} -> ${target}`);
        }
        return [{ path: relative(root, absolute).split(sep).join("/"), type: "symlink", target }];
      }
      if (entry.isDirectory()) return collectFiles(root, absolute);
      if (!entry.isFile()) throw new Error(`release artifact contains unsupported file: ${absolute}`);
      const path = relative(root, absolute).split(sep).join("/");
      if (!path || path.startsWith("../") || path.includes("/../")) {
        throw new Error(`release artifact path escaped root: ${path}`);
      }
      return [{ path, sha256: sha256File(absolute), size: stat.size }];
    });
}

export function buildReleaseManifest({ root, commit, tree, nodeVersion, platform, arch }) {
  const artifactRoot = resolve(root);
  if (!SHA256.test(commit) || !SHA256.test(tree)) {
    throw new Error("commit and tree must be full lowercase 40-character Git SHAs");
  }
  const files = collectFiles(artifactRoot);
  if (!files.some((file) => file.path === "package-lock.json")) {
    throw new Error("release artifact is missing package-lock.json");
  }
  return {
    schema_version: 1,
    commit,
    tree,
    package_lock_sha256: files.find((file) => file.path === "package-lock.json").sha256,
    runtime: { node: nodeVersion, platform, arch },
    files,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const root = argument("--root");
  const output = argument("--output");
  if (!root || !output) throw new Error("usage: releaseManifest.mjs --root DIR --output FILE");
  const manifest = buildReleaseManifest({
    root,
    commit: argument("--commit"),
    tree: argument("--tree"),
    nodeVersion: argument("--node-version") ?? process.version,
    platform: argument("--platform") ?? process.platform,
    arch: argument("--arch") ?? process.arch,
  });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640 });
}
