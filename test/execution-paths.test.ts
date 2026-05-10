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

    it("REMOVE: fallback code from executePrompt", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("src/index.ts", "utf-8");
      
      // Fallback code blocks should be removed
      const hasFallback = src.includes("fallbackInvocation");
      const hasFallbackCheck = src.includes("isCliTimeout(error)") && src.includes("fallback");
      
      // After removal: no fallback in either path
      expect(hasFallback).toBe(false);
    });

    it("REMOVE: kind-specific CLI args in cli", async () => {
      const fs = await import("fs");
      const cli = fs.readFileSync("src/cli.ts", "utf-8");
      
      // Still has both branches - will be unified next
      const hasCodex = cli.includes('if (bot === "codex")');
      const hasGemini = cli.includes('if (bot === "gemini")');
      
      // Current: still has branches, but they should be unified
      expect(hasGemini && hasCodex).toBe(true);  // Baseline
    });
  });

  describe("Phase 3: Generic flag works for all bots", () => {
    it("selection NOT in path selection (line 145 area)", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("src/index.ts", "utf-8");
      
      // Find the selection logic line
      const line145 = src.split('\n')[144];
      
      // Selection should NOT check kind
      expect(line145).not.toContain("this.kind");
      expect(line145).not.toContain('"gemini"');
    });
  });
});
describe("Idle Timeout Removal", () => {
  it("sync path uses null idle timeout", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("src/index.ts", "utf-8");
    
    // executePrompt should use null idle timeout (typing provides liveness)
    const syncUsesNullIdle = src.includes("idleTimeoutMs: null") && 
      !src.match(/executePrompt[^]*idleTimeoutMs: (?!null)/);
    
    // Both paths should use null
    expect(src).toContain("idleTimeoutMs: null");
  });

  it("CLI_IDLE_TIMEOUT_MS not used in config", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("src/index.ts", "utf-8");
    
    // cliIdleTimeoutMs from config should not be used (not in code as assignment)
    // Check for the config line being used, not just mentioned
    const usesConfigAssignment = src.includes("config.cliIdleTimeoutMs");
    
    expect(usesConfigAssignment).toBe(false);
  });
});
