import { isProviderId } from "./providers/registry.js";
import type { AdvisorConfig, AdvisorPolicyMode, AdvisorTarget } from "./advisorTypes.js";

type Env = Record<string, string | undefined>;
const positiveInt = (raw: string | undefined, fallback: number) => {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
function parseEnabled(raw: string | undefined): boolean {
  if (raw == null || raw.trim() === "") return true;
  return /^(?:1|true|yes|on)$/i.test(raw);
}
const parseMode = (raw: string | undefined): AdvisorPolicyMode => raw === "suggest" || raw === "auto" ? raw : "manual";
function parseTarget(raw: string): AdvisorTarget | null {
  const split = raw.indexOf(":");
  if (split <= 0) return null;
  const rawProvider = raw.slice(0, split).trim();
  const provider = rawProvider === "antigravity" ? "agy" : rawProvider;
  const model = raw.slice(split + 1).trim();
  return isProviderId(provider) && model ? { provider, model } : null;
}
export function parseAdvisorConfig(env: Env = process.env): AdvisorConfig {
  return {
    enabled: parseEnabled(env.BRIDGE_ADVISOR_ENABLED),
    mode: parseMode(env.BRIDGE_ADVISOR_MODE),
    chain: (env.BRIDGE_ADVISOR_CHAIN ?? "").split(",").map((v) => parseTarget(v.trim()))
      .filter((v): v is AdvisorTarget => v !== null).slice(0, 2),
    maxCallsPerTurn: positiveInt(env.BRIDGE_ADVISOR_MAX_CALLS_PER_TURN, 1),
    maxCallsPerTask: positiveInt(env.BRIDGE_ADVISOR_MAX_CALLS_PER_TASK, 2),
    timeoutMs: positiveInt(env.BRIDGE_ADVISOR_TIMEOUT_MS, 120_000),
    contextMaxChars: positiveInt(env.BRIDGE_ADVISOR_CONTEXT_MAX_CHARS, 24_000),
  };
}
