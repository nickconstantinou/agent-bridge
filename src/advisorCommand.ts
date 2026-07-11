/** PURPOSE: Untrusted agent-side client for the bridge-owned advisor broker. */
import { requestAdvisorViaBroker } from "./advisorBroker.js";
import type { AdvisorRequestMode } from "./advisorTypes.js";

type EnvLike = Record<string, string | undefined>;

function flagValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? "").trim() : "";
}

export async function runAgentAdvisorCommand(args: string[], env: EnvLike = process.env): Promise<string> {
  const capability = env.AGENT_BRIDGE_ADVISOR_CAPABILITY?.trim();
  if (!capability) throw new Error("AGENT_BRIDGE_ADVISOR_CAPABILITY is required");
  return requestAdvisorViaBroker({
    capability,
    mode: flagValue(args, "--mode") as AdvisorRequestMode,
    task: flagValue(args, "--task"),
  }, env);
}
