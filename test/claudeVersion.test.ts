import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Claude dependency version", () => {
  it("should be at least 2.1.170 in package.json", () => {
    const pkgPath = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const versionStr = pkg.dependencies["@anthropic-ai/claude-code"];
    expect(versionStr).toBeDefined();
    
    const cleanVersion = versionStr.replace(/[^0-9.]/g, "");
    const parts = cleanVersion.split(".").map(Number);
    
    expect(parts[0]).toBeGreaterThanOrEqual(2);
    if (parts[0] === 2) {
      expect(parts[1]).toBeGreaterThanOrEqual(1);
      if (parts[1] === 1) {
        expect(parts[2]).toBeGreaterThanOrEqual(170);
      }
    }
  });
});
