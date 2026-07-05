/**
 * PURPOSE: Per-chat CLI fallback chain for the worker bot.
 * Tracks which CLI is active for each chat. When a CLI is exhausted,
 * advance() moves to the next CLI in the chain. Conversation turns and
 * context injection are owned by BridgeEngine (single recorder/injector).
 * NEIGHBORS: src/index-worker.ts, src/engine.ts
 */

import type { BridgeDb } from "./db.js";

export class WorkerFallbackChain {
  private readonly chain: string[];
  private readonly chatActiveIdx = new Map<string, number>();
  private readonly db: BridgeDb;

  constructor(chain: string[], db: BridgeDb) {
    this.chain = chain;
    this.db = db;
  }

  getChain(): string[] {
    return [...this.chain];
  }

  getActiveCli(chatKey: string): string {
    const idx = this.chatActiveIdx.get(chatKey) ?? 0;
    return this.chain[Math.min(idx, this.chain.length - 1)];
  }

  setActiveCli(chatKey: string, cli: string): void {
    const idx = this.chain.indexOf(cli);
    if (idx !== -1) {
      this.chatActiveIdx.set(chatKey, idx);
    }
  }

  /** Advance to the next CLI. Returns the new active CLI, or null if already at the last. */
  advance(chatKey: string): string | null {
    const currentIdx = this.chatActiveIdx.get(chatKey) ?? 0;
    const nextIdx = currentIdx + 1;
    if (nextIdx >= this.chain.length) return null;
    this.chatActiveIdx.set(chatKey, nextIdx);
    return this.chain[nextIdx];
  }

  isChainExhausted(chatKey: string): boolean {
    return (this.chatActiveIdx.get(chatKey) ?? 0) >= this.chain.length - 1;
  }

  resetToHead(chatKey: string): void {
    this.chatActiveIdx.delete(chatKey);
  }
}
