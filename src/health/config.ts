export function parseHealthEnabled(env: Record<string, string | undefined>): boolean {
  return env.HEALTH_MONITOR_ENABLED === "true";
}

export function parseCadenceSeconds(env: Record<string, string | undefined>): number {
  const n = Number(env.HEALTH_MONITOR_CADENCE_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

type BotKind = "codex" | "antigravity" | "claude";

function parseBot(value: string | undefined): BotKind {
  if (value === "codex" || value === "antigravity" || value === "claude") return value;
  return "claude";
}

/**
 * Parses health CLI config from env vars. HEALTH_SUGGEST_* is canonical;
 * HEALTH_CLI_* is a compatibility alias and only wins when the SUGGEST variant is absent.
 */
export function parseHealthCliConfig(env: Record<string, string | undefined>): {
  bot: BotKind;
  command: string | undefined;
  modelPreference: string[];
} {
  const bot = parseBot(env.HEALTH_SUGGEST_BOT ?? env.HEALTH_CLI_BOT);
  const command = env.HEALTH_SUGGEST_COMMAND ?? env.HEALTH_CLI_COMMAND;
  const modelRaw = env.HEALTH_SUGGEST_MODEL_PREFERENCE ?? env.HEALTH_CLI_MODEL_PREFERENCE ?? "";
  const modelPreference = modelRaw.split(",").map(s => s.trim()).filter(Boolean);
  return { bot, command, modelPreference };
}
