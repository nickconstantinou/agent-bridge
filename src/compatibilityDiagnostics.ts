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

const ALIASES: ReadonlyArray<readonly [alias: string, canonical: string]> = [
  ["TELEGRAM_ALLOWED_USER_ID", "TELEGRAM_ALLOWED_USER_IDS"],
  ["WORKER_CLI_CHAIN", "INTERACTIVE_CLI_CHAIN"],
  ["HEALTH_CLI_BOT", "HEALTH_SUGGEST_BOT"],
  ["HEALTH_CLI_COMMAND", "HEALTH_SUGGEST_COMMAND"],
  ["HEALTH_CLI_MODEL_PREFERENCE", "HEALTH_SUGGEST_MODEL_PREFERENCE"],
  ["GEMINI_COMMAND", "ANTIGRAVITY_COMMAND"],
  ["GEMINI_MODEL_PREFERENCE", "ANTIGRAVITY_MODEL_PREFERENCE"],
  ["GEMINI_PROJECT_DIR", "ANTIGRAVITY_PROJECT_DIR"],
];

export function collectCompatibilityDiagnostics(
  env: Record<string, string | undefined>,
): CompatibilityDiagnostic[] {
  return ALIASES.flatMap(([alias, canonical]) => {
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
  surface: string,
  env: Record<string, string | undefined> = process.env,
  logger: (line: string) => void = console.info,
): void {
  const diagnostics = collectCompatibilityDiagnostics(env);
  if (diagnostics.length > 0) logger(formatCompatibilityDiagnostics(surface, diagnostics));
}
