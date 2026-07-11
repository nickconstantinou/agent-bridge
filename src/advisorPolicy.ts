import type { AdvisorOrigin, AdvisorPolicyMode, AdvisorTarget } from "./advisorTypes.js";
export function shouldAllowAdvisorCall(mode: AdvisorPolicyMode, origin: AdvisorOrigin, approved: boolean): boolean {
  if (origin === "manual" || origin === "worker") return true;
  if (origin === "suggest") return mode !== "manual" && approved;
  return mode === "auto";
}

// Every advisor entry point runs tool_free: the advisor model must not be able
// to execute tools. Only providers with a verified tool-disabled invocation
// qualify; today that is claude alone.
export type AdvisorExecutionProfile = "tool_free";
const TOOL_FREE_PROVIDERS = new Set<string>(["claude"]);
export function assertChainSupportsProfile(chain: AdvisorTarget[], profile: AdvisorExecutionProfile): void {
  if (profile !== "tool_free") throw new Error(`Unknown advisor execution profile: ${profile as string}`);
  const ineligible = chain.filter((target) => !TOOL_FREE_PROVIDERS.has(target.provider));
  if (ineligible.length > 0) {
    throw new Error(
      `Advisor requires a tool-free advisor provider; unsupported chain targets: ${ineligible.map((t) => t.provider).join(", ")} (currently supported: claude)`,
    );
  }
}
export function chainSupportsProfile(chain: AdvisorTarget[], profile: AdvisorExecutionProfile): boolean {
  try { assertChainSupportsProfile(chain, profile); return true; } catch { return false; }
}
