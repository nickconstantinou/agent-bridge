import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseModelPreference as bridgeParseModelPreference } from "../src/bridge.js";
import { parseModelPreference as configParseModelPreference } from "../src/config.js";

const repoRoot = process.cwd();

describe("Issue #135 Phase 1: safe cleanup contracts", () => {
  it("does not have a duplicated lowercase agents.md instruction file at repo root", () => {
    // AGENTS.md is canonical. agents.md previously duplicated architecture and
    // operating rules (including an obsolete chat-keyed lock API) and must not return.
    expect(existsSync(join(repoRoot, "agents.md"))).toBe(false);
    expect(existsSync(join(repoRoot, "AGENTS.md"))).toBe(true);
  });

  it("re-exports the exact canonical parseModelPreference from src/config.ts, not a duplicate", () => {
    // src/bridge.ts is a compatibility barrel: it must not define its own
    // implementation, and its export must be config.ts's function by identity,
    // not a lookalike.
    const source = readFileSync(join(repoRoot, "src/bridge.ts"), "utf8");
    expect(source).not.toMatch(/function\s+parseModelPreference\s*\(/);

    expect(bridgeParseModelPreference).toBe(configParseModelPreference);
    expect(bridgeParseModelPreference("a, b ,,c")).toEqual(["a", "b", "c"]);
    expect(bridgeParseModelPreference(undefined)).toEqual([]);
  });

  it("has no production dependency resolving from test/", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const prodDeps: Record<string, string> = pkg.dependencies || {};
    for (const [name, spec] of Object.entries(prodDeps)) {
      expect(spec.startsWith("file:test/"), `${name} is a production dependency resolving from test/: ${spec}`).toBe(false);
    }
  });

  it("has a repeatable cleanup audit command wired in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts).toHaveProperty("cleanup:check");
  });
});
