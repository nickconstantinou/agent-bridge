/**
 * PURPOSE: Agent-only CLI boundary for requesting bounded frontier advice.
 * INPUTS: Bridge-injected environment variables and --mode/--task arguments.
 * OUTPUTS: Formatted, non-authoritative advisor guidance on stdout.
 * NEIGHBORS: src/advisor.ts, src/engine.ts, scripts/agent-bridge-advisor.ts
 */

import { randomUUID } from "node:crypto";
import { requestAdvisor, formatAdvisorResult } from "./advisor.js";
import { parseAdvisorConfig } from "./advisorConfig.js";
import type { AdvisorRequestMode } from "./advisorTypes.js";
import { runCli } from "./cli.js";
import { loadBotsConfig } from "./config.js";
import { openDb } from "./db.js";

type EnvLike = Record<string, string | undefined>;
type AdvisorRequester = typeof requestAdvisor;

const AGENT_MODES = new Set<AdvisorRequestMode>(["plan", "review", "debug", "risk", "decision"]);

function requireEnv(env: EnvLike, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function flagValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? "").trim() : "";
}

export async function runAgentAdvisorCommand(
  args: string[],
  env: EnvLike = process.env,
  deps: { requestAdvisor?: AdvisorRequester; requestId?: () => string } = {},
): Promise<string> {
  const dbPath = requireEnv(env, "AGENT_BRIDGE_CONTEXT_DB");
  const chatKey = requireEnv(env, "AGENT_BRIDGE_CHAT_KEY");
  const cliKind = requireEnv(env, "AGENT_BRIDGE_CLI_KIND");
  const rawMode = flagValue(args, "--mode");
  if (!AGENT_MODES.has(rawMode as AdvisorRequestMode)) {
    throw new Error(`Invalid advisor mode: ${rawMode || "missing"}`);
  }
  const task = flagValue(args, "--task");
  if (!task) throw new Error("Advisor task is required");

  const db = deps.requestAdvisor ? openDb(":memory:") : openDb(dbPath);
  const turnKey = env.AGENT_BRIDGE_ADVISOR_TURN_KEY?.trim() || `${chatKey}:agent`;
  try {
    const result = await (deps.requestAdvisor ?? requestAdvisor)({
      db,
      config: parseAdvisorConfig(env),
      request: {
        requestId: (deps.requestId ?? randomUUID)(),
        scopeKey: chatKey,
        turnKey,
        taskKey: turnKey,
        origin: "manual",
        mode: rawMode as AdvisorRequestMode,
        task,
        activeProvider: cliKind,
        activeModel: db.getSetting(cliKind),
      },
      bots: loadBotsConfig(env),
      runCli,
      cwd: env.AGENT_BRIDGE_REPO_PATH?.trim() || process.cwd(),
    });
    return formatAdvisorResult(result);
  } finally {
    db.close();
  }
}
