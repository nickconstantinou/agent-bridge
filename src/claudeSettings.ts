/**
 * PURPOSE: Single abstraction for Claude CLI `--settings` payload resolution.
 * INPUTS: process-env-shaped record.
 * OUTPUTS: A resolved settings descriptor, its serialized JSON, and the CLI
 * arg pair to append to a Claude invocation.
 * NEIGHBORS: src/cli.ts (buildCliInvocation)
 * LOGIC: Issue #135 Phase 3A establishes this module as the Issue #88-
 * compatible foundation (same function names/shapes Issue #88 proposes) and
 * preserves the exact current default behaviour (CLAUDE_EXCLUDED_PLUGINS,
 * defaulting to excluding telegram@claude-plugins-official). It does not
 * implement Issue #88's "lean"/"custom" profiles, /context surfacing, or
 * payload-audit diagnostics — those remain open follow-up work on this same
 * module, tracked by Issue #88.
 */

const DEFAULT_EXCLUDED_PLUGINS = ["telegram@claude-plugins-official"];

export interface ClaudeSettings {
  /** Only "default" is implemented; Issue #88's "lean"/"custom" profiles are follow-up work. */
  profile: "default";
  excludedPlugins: string[];
}

/** Resolves the current Claude settings profile from env. Read at call time so tests can stub env. */
export function resolveClaudeSettings(env: NodeJS.ProcessEnv = process.env): ClaudeSettings {
  const raw = env.CLAUDE_EXCLUDED_PLUGINS;
  const excludedPlugins = raw === undefined
    ? [...DEFAULT_EXCLUDED_PLUGINS]
    : raw.split(",").map((plugin) => plugin.trim()).filter(Boolean);
  return { profile: "default", excludedPlugins };
}

/** Serializes resolved settings to the JSON payload Claude's --settings flag expects, or null if there's nothing to exclude. */
export function buildClaudeSettingsJson(env: NodeJS.ProcessEnv = process.env): string | null {
  const { excludedPlugins } = resolveClaudeSettings(env);
  if (!excludedPlugins.length) return null;
  return JSON.stringify({
    enabledPlugins: Object.fromEntries(excludedPlugins.map((plugin) => [plugin, false])),
  });
}

/** Returns the ["--settings", json] arg pair to append to a Claude invocation, or [] when there's nothing to configure. */
export function buildClaudeSettingsArg(env: NodeJS.ProcessEnv = process.env): string[] {
  const json = buildClaudeSettingsJson(env);
  return json ? ["--settings", json] : [];
}

/** Human-readable summary of the resolved settings, for future /context or diagnostics surfacing (not yet wired in). */
export function describeClaudeSettings(env: NodeJS.ProcessEnv = process.env): string {
  const { profile, excludedPlugins } = resolveClaudeSettings(env);
  if (!excludedPlugins.length) return `Claude settings: ${profile} profile, no plugins excluded`;
  return `Claude settings: ${profile} profile, excluding [${excludedPlugins.join(", ")}]`;
}

/**
 * @deprecated Compatibility alias for buildClaudeSettingsJson(), kept in case
 * external OSS consumers import it directly from src/cli.js. Byte-identical
 * output; prefer buildClaudeSettingsJson() or buildClaudeSettingsArg() in new
 * code.
 */
export function buildClaudeExcludedPluginSettings(env: NodeJS.ProcessEnv = process.env): string | null {
  return buildClaudeSettingsJson(env);
}
