/**
 * PURPOSE: Shared compaction service — the single path for summarising a chat's
 * conversation, promoting durable memory candidates, and pruning covered turns.
 * Used by /compact; a later PR wires the same service into fallback/switch handoff.
 * Compaction failure is non-destructive: no summary is stored and no turns are
 * pruned unless summarisation succeeds and produces valid structured output.
 * NEIGHBORS: src/engine.ts, src/compactSummary.ts, src/projectMemory.ts, src/db.ts
 */

import type { BridgeDb } from "./db.js";
import { buildCliInvocation, parseCliResult } from "./cli.js";
import { resolveEffort } from "./effort.js";
import type { BotKind } from "./types.js";
import { mapWithConcurrency } from "./concurrency.js";
import {
  buildCompactSummaryPrompt,
  buildCompactReducePrompt,
  chunkCompactTurns,
  compactParallelism,
  parseCompactOutput,
  COMPACT_TIMEOUT_MS,
  type CompactProfile,
} from "./compactSummary.js";
import { storeProjectMemoryCandidate } from "./projectMemory.js";

export interface CompactConversationDeps {
  db: BridgeDb;
  runCli: (command: string, args: string[], cwd: string, options: Record<string, unknown>) => Promise<string>;
  botConfig: { command: string; modelPreference: string[] };
  cliKind: string;
  compactProfile?: CompactProfile;
}

export type CompactConversationOutcome = "compacted" | "no_turns" | "failed";

export interface CompactConversationResult {
  outcome: CompactConversationOutcome;
  summaryMd?: string;
  turnCount?: number;
  startId?: number;
  endId?: number;
  promotedMemoryIds?: string[];
  rejectedCandidateCount?: number;
  error?: string;
}

export async function compactConversation(
  chatKey: string,
  deps: CompactConversationDeps,
): Promise<CompactConversationResult> {
  const { db, runCli, botConfig, cliKind, compactProfile = "engineering" } = deps;

  const previousSummary = db.getLatestConvSummary(chatKey);
  const turns = db.getConvTurnsForCompaction(chatKey);
  if (turns.length === 0) return { outcome: "no_turns" };

  const startId = turns[0].id;
  const endId = turns[turns.length - 1].id;
  const chunks = chunkCompactTurns(turns);

  const summarizePrompt = async (prompt: string): Promise<string> => {
    const model = db.getSetting(cliKind) || botConfig.modelPreference[0] || null;
    const invocation = buildCliInvocation({
      bot: cliKind,
      prompt,
      sessionId: null,
      command: botConfig.command,
      model,
      effort: resolveEffort(cliKind as BotKind, db),
      executionMode: "safe",
    });
    const raw = await Promise.race([
      runCli(invocation.command, invocation.args, process.cwd(), {}),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("compact timeout")), COMPACT_TIMEOUT_MS)
      ),
    ]);
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
    throw new Error("empty compact summary");
  };

  const summarizeToOutput = async (prompt: string) => {
    const raw = await summarizePrompt(prompt);
    const cliResult = parseCliResult({ bot: cliKind, stdout: raw });
    const parsed = parseCompactOutput(cliResult.text);
    if (!parsed) throw new Error("invalid compact JSON output");
    return parsed;
  };

  let finalOutput: { summaryMd: string; memoryCandidates: Array<Record<string, unknown>> };
  try {
    if (chunks.length === 1 && !previousSummary) {
      finalOutput = await summarizeToOutput(buildCompactSummaryPrompt(turns, compactProfile));
    } else {
      const parallelism = compactParallelism();
      const chunkSummaries = await mapWithConcurrency(chunks, parallelism, async (chunk) => {
        const parsed = await summarizeToOutput(buildCompactSummaryPrompt(chunk, compactProfile));
        return {
          startId: chunk[0].id!,
          endId: chunk[chunk.length - 1].id!,
          summary: parsed.summaryMd,
        };
      });
      finalOutput = await summarizeToOutput(
        buildCompactReducePrompt(previousSummary?.summary_md ?? null, chunkSummaries, compactProfile),
      );
    }
  } catch (error) {
    // Non-destructive: no summary stored, no turns pruned. Previous summary and
    // raw turns remain available so the conversation can continue.
    return {
      outcome: "failed",
      error: (error as Error).message,
      turnCount: turns.length,
      startId,
      endId,
    };
  }

  db.addConvSummary(chatKey, startId, endId, finalOutput.summaryMd);

  const promotedMemoryIds: string[] = [];
  let rejectedCandidateCount = 0;
  for (const candidate of finalOutput.memoryCandidates) {
    const result = storeProjectMemoryCandidate(db, candidate, {
      chatKey,
      cliKind,
      repoPath: process.cwd(),
    });
    if (result.status === "stored") promotedMemoryIds.push(result.id);
    else if (result.status === "rejected") rejectedCandidateCount++;
  }

  db.pruneConvTurns(chatKey, endId);

  return {
    outcome: "compacted",
    summaryMd: finalOutput.summaryMd,
    turnCount: turns.length,
    startId,
    endId,
    promotedMemoryIds,
    rejectedCandidateCount,
  };
}
