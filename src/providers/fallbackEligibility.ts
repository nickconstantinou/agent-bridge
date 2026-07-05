import { classifyAnyProviderError, isFallbackEligibleProviderError } from "./errorClassification.js";

export function isProviderFallbackEligibleError(error: Error | string): boolean {
  return isFallbackEligibleProviderError(classifyAnyProviderError(error));
}
