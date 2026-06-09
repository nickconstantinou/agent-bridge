import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Codex dependency version", () => {
  it("should be at least 0.138.0 in package.json", () => {
    const pkgPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const versionStr = pkg.dependencies["@openai/codex"];
    expect(versionStr).toBeDefined();
    
    const cleanVersion = versionStr.replace(/[^0-9.]/g, "");
    const parts = cleanVersion.split(".").map(Number);
    
    expect(parts[0]).toBeGreaterThanOrEqual(0);
    if (parts[0] === 0) {
      expect(parts[1]).toBeGreaterThanOrEqual(138);
    }
  });
});
