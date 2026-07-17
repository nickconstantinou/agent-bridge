import type { BridgeDb } from "./db.js";
import type { BotConfig, BotKind } from "./types.js";
import { buildCliInvocation, parseCliResult } from "./cli.js";
import { setAntigravityModel } from "./providers/antigravityRuntime.js";
import { classifyProviderError, isFallbackEligibleProviderError } from "./providers/errorClassification.js";
import type { ProviderId } from "./providers/types.js";
import { assertChainSupportsProfile, shouldAllowAdvisorCall, type AdvisorExecutionProfile } from "./advisorPolicy.js";
import { buildAdvisorContext, buildAdvisorPrompt, parseAdvisorOutput } from "./advisorPrompt.js";
import type { AdvisorConfig, AdvisorRequest, AdvisorResult } from "./advisorTypes.js";

type RunCli = (command: string, args: string[], cwd: string, options: Record<string, unknown>) => Promise<string>;
const botKindFor = (provider: ProviderId): BotKind => provider === "agy" ? "antigravity" : provider;
function errorKind(error: Error, provider: ProviderId): string {
  if (/invalid advisor output/i.test(error.message)) return "invalid_output";
  if (/timeout/i.test(error.message)) return "timeout";
  return classifyProviderError(provider, error).kind;
}
function fallbackEligible(error: Error, provider: ProviderId): boolean {
  const classification = classifyProviderError(provider, error);
  return /invalid advisor output|timeout|provider unavailable/i.test(error.message)
    || classification.kind === "auth_required"
    || classification.kind === "transient"
    || isFallbackEligibleProviderError(classification);
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let cancelTimeout = (): void => {};
  try {
    return await Promise.race([promise, new Promise<T>((resolve, reject) => {
      cancelTimeout = () => resolve(undefined as T);
      timer = setTimeout(() => reject(new Error("Advisor timeout")), timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    cancelTimeout();
  }
}
function parseRawResult(provider: ProviderId, raw: string) {
  try { return parseAdvisorOutput(raw); }
  catch {
    return parseAdvisorOutput(parseCliResult({ bot: botKindFor(provider), stdout: raw }).text);
  }
}

/**
 * Single private execution path for every advisor entry point (manual /advisor,
 * worker checkpoints, agent capability requests). Only AdvisorService may call
 * this; all callers share the same policy, budget, tool-free profile,
 * fallback, and audit behaviour.
 */
export async function executeAdvisorRequest(deps: {
  db: BridgeDb; config: AdvisorConfig; request: AdvisorRequest;
  bots: Partial<Record<BotKind, Pick<BotConfig, "command" | "modelPreference">>>;
  runCli: RunCli; cwd: string; executionProfile: AdvisorExecutionProfile;
}): Promise<AdvisorResult> {
  const { db, config, request, bots, runCli, cwd } = deps;
  if (!config.enabled) throw new Error("Advisor disabled");
  if (config.chain.length === 0) throw new Error("Advisor unavailable: no configured targets");
  assertChainSupportsProfile(config.chain, deps.executionProfile);
  if (!shouldAllowAdvisorCall(config.mode, request.origin, request.approved === true)) throw new Error("Advisor call denied by policy");
  const context = buildAdvisorContext(db, { scopeKey: request.scopeKey, task: request.task, maxChars: config.contextMaxChars, evidence: request.evidence });
  if (!db.reserveAdvisorCall({
    requestId: request.requestId, scopeKey: request.scopeKey, turnKey: request.turnKey,
    taskKey: request.taskKey, mode: request.mode, trigger: request.origin, contextChars: context.length,
    maxCallsPerTurn: config.maxCallsPerTurn, maxCallsPerTask: config.maxCallsPerTask,
  })) throw new Error("Advisor budget exhausted");
  const prompt = buildAdvisorPrompt({ mode: request.mode, activeProvider: request.activeProvider, activeModel: request.activeModel, context });
  let lastError: Error | null = null;
  let lastProvider = config.chain[0].provider;
  for (let index = 0; index < config.chain.length; index++) {
    const target = config.chain[index];
    lastProvider = target.provider;
    const bot = botKindFor(target.provider);
    const botConfig = bots[bot];
    const startedAt = Date.now();
    try {
      if (!botConfig?.command) throw new Error(`Advisor provider unavailable: ${target.provider}`);
      if (target.provider === "agy") setAntigravityModel(target.model);
      const invocation = buildCliInvocation({ bot, prompt, sessionId: null, command: botConfig.command, model: target.model, executionMode: "safe", outputFormat: "json", toolMode: "none" });
      const raw = await withTimeout(runCli(invocation.command, invocation.args, cwd, { timeoutMs: config.timeoutMs, advisorChild: true }), config.timeoutMs);
      const parsed = parseRawResult(target.provider, raw);
      db.addAdvisorAttempt({ requestId: request.requestId, ordinal: index + 1, provider: target.provider, model: target.model, status: "succeeded", durationMs: Date.now() - startedAt });
      db.completeAdvisorCall(request.requestId, target.provider, target.model, parsed.confidence);
      return { ...parsed, provider: target.provider, model: target.model, requestId: request.requestId };
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      lastError = error;
      db.addAdvisorAttempt({ requestId: request.requestId, ordinal: index + 1, provider: target.provider, model: target.model, status: "failed", errorKind: errorKind(error, target.provider), durationMs: Date.now() - startedAt });
      if (index + 1 >= config.chain.length || !fallbackEligible(error, target.provider)) break;
    }
  }
  db.failAdvisorCall(request.requestId, lastError ? errorKind(lastError, lastProvider) : "unknown");
  throw lastError ?? new Error("Advisor failed");
}

export function formatAdvisorResult(result: AdvisorResult): string {
  return [
    "**Advisor view**", "", result.adviceMd,
    ...(result.risks.length ? ["", "**Risks**", ...result.risks.map((risk) => `- ${risk}`)] : []),
    ...(result.suggestedNextSteps.length ? ["", "**Next steps**", ...result.suggestedNextSteps.map((step) => `- ${step}`)] : []),
    "", `Advisor: ${result.provider}:${result.model} · confidence ${result.confidence}`,
  ].join("\n");
}
