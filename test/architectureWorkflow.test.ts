import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Architecture Lint workflow", () => {
  it("runs for the exact post-merge main commit as well as pull requests", () => {
    const workflow = readFileSync(new URL("../.github/workflows/architecture-lint.yml", import.meta.url), "utf8");

    expect(workflow).toMatch(/on:\s*\n\s+push:\s*\n\s+branches:\s*\[main\]/);
    expect(workflow).toMatch(/\n\s+pull_request:/);
  });
});
