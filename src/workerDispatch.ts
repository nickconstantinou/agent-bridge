/**
 * PURPOSE: Dispatch-with-fallback orchestration for the worker bot.
 * Routes a Telegram update to the active CLI engine. If capacity is exhausted,
 * advances the fallback chain, injects context preamble, and retries.
 * NEIGHBORS: src/index-worker.ts, src/workerFallback.ts, src/engine.ts
 */

import { WorkerFallbackChain } from "./workerFallback.js";
import { runCli, isCapacityExhaustedError } from "./cli.js";
import { appendEffortArgs, type EffortLevel } from "./effort.js";

export interface DispatchEngine {
  handleUpdate(update: any): Promise<void>;
}

export interface DispatchDeps {
  engines: Record<string, DispatchEngine>;
  fallbackChain: WorkerFallbackChain;
  exhaustedChats: Set<string>;
  contextPreambles: Map<string, string>;
  /** Called to send a notification message to the user. */
  notify: (message: string) => void | Promise<void>;
}

export async function dispatchWithFallback(
  update: any,
  chatKey: string,
  deps: DispatchDeps,
): Promise<void> {
  const { engines, fallbackChain, exhaustedChats, contextPreambles, notify } = deps;

  exhaustedChats.delete(chatKey);
  const activeCli = fallbackChain.getActiveCli(chatKey);
  await engines[activeCli].handleUpdate(update);

  if (exhaustedChats.has(chatKey)) {
    exhaustedChats.delete(chatKey);
    const next = fallbackChain.advance(chatKey);
    if (next) {
      contextPreambles.set(chatKey, fallbackChain.buildContextPreamble(chatKey));
      await notify(`Switching to ${next} (${activeCli} at capacity)`);
      await dispatchWithFallback(update, chatKey, deps);
    } else {
      await notify("All CLIs are currently unavailable. Please try again later.");
    }
  }
}

export function getCliCommandForKind(kind: string): string {
  if (kind === "codex") return process.env.CODEX_COMMAND || "codex";
  if (kind === "antigravity") return process.env.ANTIGRAVITY_COMMAND || "agy";
  if (kind === "claude") return process.env.CLAUDE_COMMAND || "claude";
  return kind;
}

// Wrapper that retries execution using the worker CLI chain if capacity is exhausted
export async function runCliWithFallback(
  command: string,
  args: string[],
  cwd: string,
  cliChain: string[],
  options?: any & { effort?: EffortLevel },
): Promise<string> {
  const resolvedChain = cliChain.map(getCliCommandForKind);

  let currentIdx = resolvedChain.indexOf(command);
  if (currentIdx === -1) {
    currentIdx = cliChain.indexOf(command);
  }

  let nextIdx = currentIdx !== -1 ? currentIdx + 1 : 0;
  let currentCmd = currentIdx !== -1 ? resolvedChain[currentIdx] : command;

  for (;;) {
    try {
      return await runCli(currentCmd, appendEffortArgs(currentCmd, args, options?.effort), cwd, options);
    } catch (err: any) {
      if (isCapacityExhaustedError(err instanceof Error ? err : new Error(String(err)))) {
        if (nextIdx < resolvedChain.length) {
          const nextCmd = resolvedChain[nextIdx];
          const nextKind = cliChain[nextIdx];
          console.warn(`[worker-fallback] command ${currentCmd} exhausted, falling back to ${nextKind} (${nextCmd})`);
          currentCmd = nextCmd;
          nextIdx++;
          continue;
        }
      }
      throw err;
    }
  }
}
