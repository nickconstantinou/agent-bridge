import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("production source hygiene", () => {
  it("does not embed Vitest or test-env cleanup logic in workerBot production code", () => {
    const source = readFileSync(join(process.cwd(), "src/workerBot.ts"), "utf8");

    expect(source).not.toMatch(/from\s+["']vitest["']|import\(["']vitest["']\)/);
    expect(source).not.toContain("VITEST_WORKER_ID");
    expect(source).not.toMatch(/delete\s+process\.env\.WORKER_DEFAULT_REPO/);
  });
});
