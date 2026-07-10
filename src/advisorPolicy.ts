import type { AdvisorOrigin, AdvisorPolicyMode } from "./advisorTypes.js";
export function shouldAllowAdvisorCall(mode: AdvisorPolicyMode, origin: AdvisorOrigin, approved: boolean): boolean {
  if (origin === "manual" || origin === "worker") return true;
  if (origin === "suggest") return mode !== "manual" && approved;
  return mode === "auto";
}
