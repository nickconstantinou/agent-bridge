import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Test the actual execution path logic by inspecting the source
describe("Execution Path Selection - TDD", () => {
  const selectionLogicPattern = /const useAsync = (.+);/;
  
  describe("Phase 2: Green - Required changes", () => {
    it("REMOVE: buildGeminiFallbackInvocation import", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("src/index.ts", "utf-8");
      
      // Should NOT import the fallback builder
      const hasImport = src.includes("buildGeminiFallbackInvocation");
      // This is now removed
      expect(hasImport).toBe(false);
    });

    it("timeout-based fallback removed; capacity-based fallback uses isCapacityExhaustedError", async () => {
      const fs = await import("fs");
      // Execution logic now lives in engine.ts (extracted from index.ts)
      const src = fs.readFileSync("src/engine.ts", "utf-8");

      // Old timeout-based fallback must be gone
      expect(src.includes("isCliTimeout(error)")).toBe(false);
      // New capacity-based fallback is intentionally present
      expect(src.includes("isCapacityExhaustedError")).toBe(true);
      expect(src.includes("getNextFallbackModel")).toBe(true);
    });

    it("REMOVE: kind-specific CLI args in cli", async () => {
      const fs = await import("fs");
      const cli = fs.readFileSync("src/cli.ts", "utf-8");
      
      // Still has both branches - will be unified next
      const hasCodex = cli.includes('if (bot === "codex")');
      const hasAntigravity = cli.includes('if (bot === "antigravity")');
      
      // Current: still has branches, but they should be unified
      expect(hasAntigravity && hasCodex).toBe(true);  // Baseline
    });
  });

  describe("Phase 3: Generic flag works for all bots", () => {
    it("useAsync assignment does not branch on bot kind", async () => {
      const fs = await import("fs");
      // Execution logic now lives in engine.ts (extracted from index.ts)
      const src = fs.readFileSync("src/engine.ts", "utf-8");

      // The useAsync flag must be set from config alone, not per-bot-kind
      const useAsyncLine = src.split("\n").find((l) => l.includes("useAsync") && l.includes("=") && !l.includes("if") && !l.includes("await"));
      expect(useAsyncLine).toBeDefined();
      expect(useAsyncLine).not.toContain("this.kind");
      expect(useAsyncLine).not.toContain('"gemini"');
    });
  });
});
describe("Idle Timeout Config", () => {
  it("buildExecutionOptions returns per-kind timeouts (antigravity idle default 3600s)", async () => {
    const { buildExecutionOptions } = await import("../src/cli.js");
    const savedAntigravityIdle = process.env.ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS;
    const savedGlobalIdle = process.env.CLI_IDLE_TIMEOUT_MS;
    const savedAntigravityHard = process.env.ANTIGRAVITY_CLI_TIMEOUT_MS;
    const savedGlobalHard = process.env.CLI_TIMEOUT_MS;
    delete process.env.ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS;
    delete process.env.CLI_IDLE_TIMEOUT_MS;
    delete process.env.ANTIGRAVITY_CLI_TIMEOUT_MS;
    delete process.env.CLI_TIMEOUT_MS;
    try {
      const opts = buildExecutionOptions("antigravity");
      expect(opts.idleTimeoutMs).toBe(3_600_000);
      expect(opts.timeoutMs).toBe(3_600_000);
    } finally {
      if (savedAntigravityIdle !== undefined) process.env.ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS = savedAntigravityIdle;
      if (savedGlobalIdle !== undefined) process.env.CLI_IDLE_TIMEOUT_MS = savedGlobalIdle;
      if (savedAntigravityHard !== undefined) process.env.ANTIGRAVITY_CLI_TIMEOUT_MS = savedAntigravityHard;
      if (savedGlobalHard !== undefined) process.env.CLI_TIMEOUT_MS = savedGlobalHard;
    }
  });

  it("install script runs shared-memory setup as the target user instead of the sudo home", async () => {
    const fs = await import("fs");
    const installScript = fs.readFileSync("scripts/install.sh", "utf-8");
    expect(installScript).toContain('TARGET_USER="${SUDO_USER:-${USER}}"');
    expect(installScript).toContain('SHARED_MEMORY_HOME="${TARGET_HOME}"');
    expect(installScript).toContain('sudo -u "${TARGET_USER}"');
  });

  it("install scripts support non-interactive shared skill installation for the target home", async () => {
    const fs = await import("fs");
    const installScript = fs.readFileSync("scripts/install.sh", "utf-8");
    const deploymentScript = fs.readFileSync("scripts/install-deployment.sh", "utf-8");

    for (const script of [installScript, deploymentScript]) {
      expect(script).toContain("AGENT_BRIDGE_SKILLS");
      expect(script).toContain("AGENT_BRIDGE_SKILL_LINK_MODE");
      expect(script).toContain("scripts/skill-manager.ts install");
      expect(script).toContain('SHARED_MEMORY_HOME="${TARGET_HOME}"');
    }
  });
});
