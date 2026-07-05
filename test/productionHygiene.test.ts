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

  const entrypoints = [
    "src/index-interactive.ts",
    "src/index-worker.ts",
    "src/index-discord-interactive.ts",
  ];

  it("entrypoints do not record conversation turns (engine._rememberTurn is the single recorder)", () => {
    for (const file of entrypoints) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, `${file} duplicates engine turn recording`).not.toContain("fallbackChain.addTurn");
    }
  });

  it("entrypoints and dispatchers do not inject context preambles (engine injects context once per execution)", () => {
    for (const file of [...entrypoints, "src/interactiveBot.ts", "src/workerDispatch.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, `${file} duplicates engine context injection`).not.toContain("buildContextPreamble");
      expect(source, `${file} duplicates engine context injection`).not.toContain("contextPreambles");
    }
  });
});
