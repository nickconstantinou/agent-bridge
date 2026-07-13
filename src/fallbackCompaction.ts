/**
 * PURPOSE: Selects one healthy, tool-free provider for capacity-fallback
 * compaction and runs the shared database-owned compaction service.
 * NEIGHBORS: src/interactiveBot.ts, src/compactConversation.ts, src/index*.ts
 */

import type { BridgeDb } from "./db.js";
import {
  compactConversation,
  type CompactConversationDeps,
  type CompactConversationResult,
} from "./compactConversation.js";
import type { CompactProfile } from "./compactSummary.js";
import type { BotConfig, BotKind } from "./types.js";

const TOOL_FREE_COMPACTION_PROVIDERS = new Set<BotKind>(["codex", "claude", "antigravity"]);

export interface CapacityFallbackCompactionRequest {
  chatKey: string;
  fromCli: BotKind;
  toCli: BotKind;
  exhaustedClis: readonly BotKind[];
}

export function parseCompactionProviderChain(raw: string | undefined): BotKind[] {
  const providers: BotKind[] = [];
  const seen = new Set<BotKind>();
  for (const entry of (raw ?? "").split(",")) {
    const value = entry.trim() === "agy" ? "antigravity" : entry.trim();
    if (!TOOL_FREE_COMPACTION_PROVIDERS.has(value as BotKind)) continue;
    const provider = value as BotKind;
    if (seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }
  return providers;
}

export function selectCapacityFallbackCompactionTarget(input: {
  toCli: BotKind;
  exhaustedClis: readonly BotKind[];
  configuredChain: readonly BotKind[];
}): BotKind | null {
  const exhausted = new Set(input.exhaustedClis);
  return [input.toCli, ...input.configuredChain].find((provider) =>
    TOOL_FREE_COMPACTION_PROVIDERS.has(provider) && !exhausted.has(provider)
  ) ?? null;
}

export async function runCapacityFallbackCompaction(
  request: CapacityFallbackCompactionRequest,
  deps: {
    db: BridgeDb;
    runCli: CompactConversationDeps["runCli"];
    bots: Partial<Record<BotKind, Pick<BotConfig, "command" | "modelPreference">>>;
    configuredChain: readonly BotKind[];
    compactProfile: CompactProfile;
  },
): Promise<CompactConversationResult> {
  const target = selectCapacityFallbackCompactionTarget({
    toCli: request.toCli,
    exhaustedClis: [...request.exhaustedClis, request.fromCli],
    configuredChain: deps.configuredChain,
  });
  if (!target) {
    return {
      outcome: "failed",
      trigger: "capacity_fallback",
      error: "No healthy tool-free compaction provider is available",
    };
  }

  const botConfig = deps.bots[target];
  if (!botConfig) {
    return {
      outcome: "failed",
      trigger: "capacity_fallback",
      error: `Compaction provider unavailable: ${target}`,
    };
  }

  return compactConversation(request.chatKey, {
    db: deps.db,
    runCli: deps.runCli,
    botConfig,
    cliKind: target,
    trigger: "capacity_fallback",
    compactProfile: deps.compactProfile,
  });
}
