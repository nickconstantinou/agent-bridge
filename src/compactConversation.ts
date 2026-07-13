/**
 * PURPOSE: Shared compaction service — the single path for summarising a chat's
 * conversation, promoting durable memory candidates, and pruning covered turns.
 * Used by /compact; a later PR wires the same service into fallback/switch handoff.
 * Compaction failure is non-destructive: no summary is stored and no turns are
 * pruned unless summarisation succeeds and produces valid structured output.
 * NEIGHBORS: src/engine.ts, src/compactSummary.ts, src/projectMemory.ts, src/db.ts
 */

import type { BridgeDb } from "./db.js";
import { buildCliInvocation, buildExecutionOptions, parseCliResult } from "./cli.js";
import { resolveEffort } from "./effort.js";
import type { BotKind, CliOptions } from "./types.js";
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
import type { CompactionErrorCategory } from "./repositories/compactionRepository.js";

export interface CompactConversationDeps {
  db: BridgeDb;
  runCli: (command: string, args: string[], cwd: string, options: CliOptions) => Promise<string>;
  botConfig: { command: string; modelPreference: string[] };
  cliKind: string;
  trigger: CompactionTrigger;
  compactProfile?: CompactProfile;
  now?: () => Date;
}

export type CompactConversationOutcome = "compacted" | "no_turns" | "failed";
export type CompactionTrigger = "manual" | "preseed" | "capacity_fallback";

export interface CompactConversationResult {
  outcome: CompactConversationOutcome;
  trigger: CompactionTrigger;
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
  const { db, runCli, botConfig, cliKind, trigger, compactProfile = "engineering", now = () => new Date() } = deps;
  const startedAt = now();
  const model = db.getSetting(cliKind) || botConfig.modelPreference[0] || null;
  let cliCallCount = 0;
  let chunkCount = 0;
  let rangeStartTurnId: number | null = null;
  let rangeEndTurnId: number | null = null;

  const finish = (
    result: CompactConversationResult,
    errorCategory: CompactionErrorCategory | null = null,
  ): CompactConversationResult => {
    const endedAt = now();
    try {
      db.addCompactionAttempt({
        chatKey,
        trigger,
        provider: cliKind,
        model,
        outcome: result.outcome,
        errorCategory,
        durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
        chunkCount,
        cliCallCount,
        rangeStartTurnId,
        rangeEndTurnId,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      });
    } catch {
      console.warn(`[compaction-telemetry] write failed for ${trigger}/${result.outcome}`);
    }
    return result;
  };

  const previousSummary = db.getLatestConvSummary(chatKey);
  const turns = db.getConvTurnsForCompaction(chatKey);
  if (turns.length === 0) return finish({ outcome: "no_turns", trigger });

  const startId = turns[0].id;
  const endId = turns[turns.length - 1].id;
  const chunks = chunkCompactTurns(turns);
  chunkCount = chunks.length;
  rangeStartTurnId = startId;
  rangeEndTurnId = endId;

  const summarizePrompt = async (prompt: string): Promise<string> => {
    if (cliKind === "kimchi") {
      throw new Error("Kimchi compaction is disabled because verified tool-free execution is not supported");
    }
    const invocation = buildCliInvocation({
      bot: cliKind,
      prompt,
      sessionId: null,
      command: botConfig.command,
      model,
      effort: resolveEffort(cliKind as BotKind, db),
      executionMode: "safe",
      outputFormat: cliKind === "codex" || cliKind === "claude" ? "json" : null,
      toolMode: "none",
    });
    cliCallCount++;
    const raw = await Promise.race([
      runCli(invocation.command, invocation.args, process.cwd(), buildExecutionOptions(cliKind as BotKind)),
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
    const message = (error as Error).message;
    return finish({
      outcome: "failed",
      trigger,
      error: message,
      turnCount: turns.length,
      startId,
      endId,
    }, classifyCompactionError(message));
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

  return finish({
    outcome: "compacted",
    trigger,
    summaryMd: finalOutput.summaryMd,
    turnCount: turns.length,
    startId,
    endId,
    promotedMemoryIds,
    rejectedCandidateCount,
  });
}

function classifyCompactionError(message: string): CompactionErrorCategory {
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/capacity|rate.?limit|quota|session limit/i.test(message)) return "capacity";
  if (/auth|unauthori[sz]ed|credential|login/i.test(message)) return "auth";
  if (/invalid compact JSON|empty compact summary/i.test(message)) return "invalid_output";
  if (/unavailable|not found|ENOENT|disabled because|no healthy/i.test(message)) return "provider_unavailable";
  if (/ECONN|network|temporary|transient|service unavailable|HTTP 5\d\d/i.test(message)) return "transient";
  return "unknown";
}
