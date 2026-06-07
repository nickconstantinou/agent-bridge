import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = new URL("..", import.meta.url).pathname;

function readSource(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("startup orphan cleanup", () => {
  it("does not use broad pkill cleanup in bridge entrypoints", () => {
    const entrypoints = [
      "src/index.ts",
      "src/index-interactive.ts",
    ];

    for (const entrypoint of entrypoints) {
      const source = readSource(entrypoint);
      expect(source, `${entrypoint} should rely on service-scoped cleanup`).not.toContain("pkill");
      expect(source, `${entrypoint} should not kill CLI processes by global pattern`).not.toContain("killOrphanedCli");
    }
  });
});
