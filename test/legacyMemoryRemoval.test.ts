import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("legacy shared-memory CLI removal", () => {
  it("removes the old agent-memory npm scripts and implementation files", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));

    expect(pkg.scripts).not.toHaveProperty("agent-memory");
    expect(pkg.scripts).not.toHaveProperty("setup:shared-memory");
    expect(pkg.scripts).not.toHaveProperty("verify:shared-memory");

    for (const path of [
      "scripts/agent-memory.ts",
      "scripts/setup-shared-memory.ts",
      "scripts/seed-agent-memory.ts",
      "scripts/test-agent-memory.sh",
      "src/agentMemory.ts",
      "src/sharedMemory.ts",
      "test/agentMemory.test.ts",
      "test/sharedMemory.test.ts",
    ]) {
      expect(existsSync(path), path).toBe(false);
    }
  });

  it("removes the old /memory command and install-time shared-memory setup", () => {
    const commands = readFileSync("src/commands.ts", "utf8");
    const install = readFileSync("scripts/install.sh", "utf8");
    const deployment = readFileSync("scripts/install-deployment.sh", "utf8");

    expect(commands).not.toContain("/memory");
    expect(commands).not.toContain("agent-memory");
    expect(install).not.toContain("setup-shared-memory");
    expect(install).not.toContain("AGENT_MEMORY_DB_PATH");
    expect(deployment).not.toContain("setup-shared-memory");
    expect(deployment).not.toContain("AGENT_MEMORY_DB_PATH");
  });
});
