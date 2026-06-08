/**
 * PURPOSE: Dispatch-with-fallback orchestration for the worker bot.
 * Routes a Telegram update to the active CLI engine. If capacity is exhausted,
 * advances the fallback chain, injects context preamble, and retries.
 * NEIGHBORS: src/index-worker.ts, src/workerFallback.ts, src/engine.ts
 */

import { WorkerFallbackChain } from "./workerFallback.js";

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
