import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Codex dependency", () => {
  it("should NOT be in package.json dependencies (managed as an external global install)", () => {
    const pkgPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    expect(pkg.dependencies["@openai/codex"]).toBeUndefined();
  });
});
