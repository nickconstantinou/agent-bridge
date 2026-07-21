/**
 * PURPOSE: Secret-safe metadata diagnostics for compatibility aliases.
 * INPUTS: Process-environment-shaped configuration.
 * OUTPUTS: Alias names, canonical names, and selected/shadowed state only.
 * SAFETY: Never includes configured values, tokens, paths, commands, or IDs.
 */

export type CompatibilityDiagnostic = {
  alias: string;
  canonical: string;
  state: "selected" | "shadowed";
};

export type CompatibilitySurface =
  | "telegram-standalone"
  | "telegram-worker"
  | "telegram-interactive"
  | "telegram-health"
  | "discord-interactive";

type Alias = readonly [alias: string, canonical: string];

const TELEGRAM_USER_ID: Alias = ["TELEGRAM_ALLOWED_USER_ID", "TELEGRAM_ALLOWED_USER_IDS"];
const WORKER_CHAIN: Alias = ["WORKER_CLI_CHAIN", "INTERACTIVE_CLI_CHAIN"];
const HEALTH_ALIASES: ReadonlyArray<Alias> = [
  ["HEALTH_CLI_BOT", "HEALTH_SUGGEST_BOT"],
  ["HEALTH_CLI_COMMAND", "HEALTH_SUGGEST_COMMAND"],
  ["HEALTH_CLI_MODEL_PREFERENCE", "HEALTH_SUGGEST_MODEL_PREFERENCE"],
];
const GEMINI_ALIASES: ReadonlyArray<Alias> = [
  ["GEMINI_COMMAND", "ANTIGRAVITY_COMMAND"],
  ["GEMINI_MODEL_PREFERENCE", "ANTIGRAVITY_MODEL_PREFERENCE"],
  ["GEMINI_PROJECT_DIR", "ANTIGRAVITY_PROJECT_DIR"],
];

// This registry describes actual consumers, not merely variables present in a
// service environment. WORKER_CLI_CHAIN is worker-owned; it is a compatibility
// alias only where Telegram interactive falls back to it.
const SURFACE_ALIASES: Record<CompatibilitySurface, ReadonlyArray<Alias>> = {
  "telegram-standalone": [TELEGRAM_USER_ID, ...GEMINI_ALIASES],
  "telegram-worker": [TELEGRAM_USER_ID, ...GEMINI_ALIASES],
  "telegram-interactive": [TELEGRAM_USER_ID, WORKER_CHAIN, ...GEMINI_ALIASES],
  "telegram-health": HEALTH_ALIASES,
  "discord-interactive": GEMINI_ALIASES,
};

export function collectCompatibilityDiagnostics(
  surface: CompatibilitySurface,
  env: Record<string, string | undefined>,
): CompatibilityDiagnostic[] {
  return SURFACE_ALIASES[surface].flatMap(([alias, canonical]) => {
    if (env[alias] === undefined) return [];
    return [{ alias, canonical, state: env[canonical] === undefined ? "selected" : "shadowed" }];
  });
}

export function formatCompatibilityDiagnostics(
  surface: string,
  diagnostics: CompatibilityDiagnostic[],
): string {
  return `[compatibility] ${JSON.stringify({ surface, aliases: diagnostics })}`;
}

export function logCompatibilityDiagnostics(
  surface: CompatibilitySurface,
  env: Record<string, string | undefined> = process.env,
  logger: (line: string) => void = console.info,
): void {
  const diagnostics = collectCompatibilityDiagnostics(surface, env);
  if (diagnostics.length > 0) logger(formatCompatibilityDiagnostics(surface, diagnostics));
}
