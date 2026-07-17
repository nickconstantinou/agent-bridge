import { describe, expect, it } from "vitest";
import {
  resolveClaudeSettings,
  buildClaudeSettingsJson,
  buildClaudeSettingsArg,
  describeClaudeSettings,
} from "../src/claudeSettings.js";

// Issue #135 Phase 3A. Issue #88-compatible API surface — same function
// names/shapes Issue #88 proposes, preserving the exact current default
// behaviour (CLAUDE_EXCLUDED_PLUGINS override, defaulting to excluding
// telegram@claude-plugins-official). "lean"/"custom" profiles, /context
// surfacing, and payload-audit diagnostics are explicitly NOT implemented
// here — that stays open follow-up work on Issue #88.

describe("resolveClaudeSettings", () => {
  it("defaults to excluding telegram@claude-plugins-official when CLAUDE_EXCLUDED_PLUGINS is unset", () => {
    expect(resolveClaudeSettings({})).toEqual({ profile: "default", excludedPlugins: ["telegram@claude-plugins-official"] });
  });

  it("honors a custom comma-separated CLAUDE_EXCLUDED_PLUGINS list", () => {
    expect(resolveClaudeSettings({ CLAUDE_EXCLUDED_PLUGINS: "a@x, b@y ,c@z" })).toEqual({
      profile: "default",
      excludedPlugins: ["a@x", "b@y", "c@z"],
    });
  });

  it("an explicit empty CLAUDE_EXCLUDED_PLUGINS excludes nothing", () => {
    expect(resolveClaudeSettings({ CLAUDE_EXCLUDED_PLUGINS: "" })).toEqual({ profile: "default", excludedPlugins: [] });
  });

  it("only 'default' is a valid profile — this is not Issue #88's lean/custom feature", () => {
    expect(resolveClaudeSettings({}).profile).toBe("default");
  });

  it("mutating one caller's excludedPlugins array does not affect a later resolution", () => {
    const first = resolveClaudeSettings({});
    first.excludedPlugins.push("mutated@evil");
    const second = resolveClaudeSettings({});
    expect(second.excludedPlugins).toEqual(["telegram@claude-plugins-official"]);
  });
});

describe("buildClaudeSettingsJson", () => {
  it("returns null when there is nothing to exclude", () => {
    expect(buildClaudeSettingsJson({ CLAUDE_EXCLUDED_PLUGINS: "" })).toBeNull();
  });

  it("returns the enabledPlugins:false JSON payload Claude's --settings expects", () => {
    const json = buildClaudeSettingsJson({});
    expect(JSON.parse(json!)).toEqual({ enabledPlugins: { "telegram@claude-plugins-official": false } });
  });

  it("serializes multiple excluded plugins", () => {
    const json = buildClaudeSettingsJson({ CLAUDE_EXCLUDED_PLUGINS: "a@x,b@y" });
    expect(JSON.parse(json!)).toEqual({ enabledPlugins: { "a@x": false, "b@y": false } });
  });
});

describe("buildClaudeSettingsArg", () => {
  it("returns an empty array when there is nothing to exclude", () => {
    expect(buildClaudeSettingsArg({ CLAUDE_EXCLUDED_PLUGINS: "" })).toEqual([]);
  });

  it("returns ['--settings', json] when there is something to exclude", () => {
    const arg = buildClaudeSettingsArg({});
    expect(arg[0]).toBe("--settings");
    expect(JSON.parse(arg[1])).toEqual({ enabledPlugins: { "telegram@claude-plugins-official": false } });
  });
});

describe("describeClaudeSettings", () => {
  it("describes the default profile with no exclusions", () => {
    expect(describeClaudeSettings({ CLAUDE_EXCLUDED_PLUGINS: "" })).toBe("Claude settings: default profile, no plugins excluded");
  });

  it("describes the default profile with exclusions", () => {
    expect(describeClaudeSettings({})).toBe("Claude settings: default profile, excluding [telegram@claude-plugins-official]");
  });
});

describe("buildClaudeExcludedPluginSettings — compatibility alias", () => {
  it("is still importable from src/cli.js for external OSS consumers", async () => {
    const cliModule = await import("../src/cli.js");
    expect(typeof cliModule.buildClaudeExcludedPluginSettings).toBe("function");
  });

  it("produces the exact same payload as buildClaudeSettingsJson", async () => {
    const { buildClaudeExcludedPluginSettings } = await import("../src/cli.js");
    expect(buildClaudeExcludedPluginSettings({})).toBe(buildClaudeSettingsJson({}));
    expect(buildClaudeExcludedPluginSettings({ CLAUDE_EXCLUDED_PLUGINS: "a@x,b@y" }))
      .toBe(buildClaudeSettingsJson({ CLAUDE_EXCLUDED_PLUGINS: "a@x,b@y" }));
    expect(buildClaudeExcludedPluginSettings({ CLAUDE_EXCLUDED_PLUGINS: "" })).toBeNull();
  });
});
