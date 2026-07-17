import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();

function source(file: string): string {
  return readFileSync(join(repoRoot, file), "utf8");
}

describe("Issue #135 Phase 3D: internal ownership boundaries", () => {
  it("entrypoints import config, database, and supervisor owners directly", () => {
    for (const file of [
      "src/index.ts",
      "src/index-worker.ts",
      "src/index-interactive.ts",
      "src/index-discord-interactive.ts",
      "src/index-health.ts",
    ]) {
      const text = source(file);
      expect(text, `${file} must not source config/db/supervisor APIs from bridge.ts`).not.toMatch(
        /import[\s\S]{0,500}\b(?:validateBridgeConfig|openDb|BridgeDb|shutdownCliProcesses)\b[\s\S]{0,120}from ["']\.\/bridge\.js["']/,
      );
    }
  });

  it("internal provider callers import Antigravity and Kimchi state owners directly", () => {
    for (const file of ["src/engine.ts", "src/compactConversation.ts", "src/advisor.ts"]) {
      const text = source(file);
      expect(text, `${file} must not import provider state helpers from cli.ts`).not.toMatch(
        /import[\s\S]{0,700}\b(?:setAntigravityModel|resolveAntigravityConversationId|resolveKimchiSessionId)\b[\s\S]{0,120}from ["'][^"']*cli\.js["']/,
      );
    }
  });

  it("bridge.ts remains a compatibility barrel without owning migrated implementations", () => {
    const text = source("src/bridge.ts");
    expect(text).not.toMatch(/function\s+parseModelPreference\s*\(/);
    expect(text).not.toMatch(/function\s+(buildInvocation|parseResult)\s*\(/);
    expect(text).toContain('export { validateBridgeConfig, parseModelPreference } from "./config.js";');
  });

  it("provider capability policy has one registry owner", () => {
    for (const file of ["src/compactConversation.ts", "src/advisorPolicy.ts"]) {
      expect(source(file), `${file} must not define a provider capability set`).not.toMatch(
        /TOOL_FREE_PROVIDERS|new Set<string>\(\[\s*["'](?:codex|claude|agy|antigravity)/,
      );
    }
    expect(source("src/providers/registry.ts")).toContain("toolFree");
  });
});
