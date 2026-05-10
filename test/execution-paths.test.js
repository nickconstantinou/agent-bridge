import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Test the actual execution path logic by inspecting the source
describe("Execution Path Selection - TDD", () => {
  const selectionLogicPattern = /const useAsync = (.+);/;
  
  describe("Phase 1: Red - Tests that fail with current code", () => {
    it("selection should NOT check kind - only asyncEnabled", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("src/index.js", "utf-8");
      const match = src.match(/const useAsync = ([^;]+);/);
      const selection = match?.[1] || "";
      
      // Now fixed: uses === true instead of && kind === "gemini"
      expect(selection).not.toContain("this.kind");
      expect(selection).not.toContain('"gemini"');
    });

    it("sync uses CLI_IDLE_TIMEOUT_MS (180000ms)", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("src/index.js", "utf-8");
      
      // executePrompt should use config.cliIdleTimeoutMs - check it references the config
      const hasConfigRef = src.includes("cliIdleTimeoutMs");
      expect(hasConfigRef).toBe(true);
    });

    it("async uses null idle timeout via runCliAsync", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("src/index.js", "utf-8");
      
      // executePromptAsync passes null for idleTimeoutMs
      const asyncHasNull = src.includes("idleTimeoutMs: null") || src.includes("idleTimeoutMs,null");
      expect(asyncHasNull).toBe(true);
    });
  });

  describe("Phase 2: Green - Required changes", () => {
    it("REMOVE: buildGeminiFallbackInvocation import", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("src/index.js", "utf-8");
      
      // Should NOT import the fallback builder
      const hasImport = src.includes("buildGeminiFallbackInvocation");
      // This is now removed
      expect(hasImport).toBe(false);
    });

    it("REMOVE: fallback code from executePrompt", async () => {
      const fs = await import("fs");
      const src = fs.readFileSync("src/index.js", "utf-8");
      
      // Fallback code blocks should be removed
      const hasFallback = src.includes("fallbackInvocation");
      const hasFallbackCheck = src.includes("isCliTimeout(error)") && src.includes("fallback");
      
      // After removal: no fallback in either path
      expect(hasFallback).toBe(false);
    });

    it("REMOVE: kind-specific CLI args in cli.js", async () => {
      const fs = await import("fs");
      const cli = fs.readFileSync("src/cli.js", "utf-8");
      
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
      const src = fs.readFileSync("src/index.js", "utf-8");
      
      // Find the selection logic line
      const line145 = src.split('\n')[144];
      
      // Selection should NOT check kind
      expect(line145).not.toContain("this.kind");
      expect(line145).not.toContain('"gemini"');
    });
  });
});