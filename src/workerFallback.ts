/**
 * PURPOSE: Per-chat CLI fallback chain for the worker bot.
 * Tracks which CLI is active for each chat and the last N message turns.
 * When a CLI is exhausted, advance() moves to the next CLI in the chain and
 * buildContextPreamble() returns the recent turns as inline context.
 * NEIGHBORS: src/index-worker.ts, src/engine.ts
 */

export const CONTEXT_TURNS = 3;

export type WorkerTurn = { role: "user" | "assistant"; text: string };

export class WorkerFallbackChain {
  private readonly chain: string[];
  private readonly chatActiveIdx = new Map<string, number>();
  private readonly chatTurns = new Map<string, WorkerTurn[]>();

  constructor(chain: string[]) {
    this.chain = chain;
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

  addTurn(chatKey: string, role: "user" | "assistant", text: string): void {
    const turns = this.chatTurns.get(chatKey) ?? [];
    turns.push({ role, text });
    while (turns.length > CONTEXT_TURNS * 2) turns.shift();
    this.chatTurns.set(chatKey, turns);
  }

  buildContextPreamble(chatKey: string): string {
    const turns = this.chatTurns.get(chatKey) ?? [];
    if (turns.length === 0) return "";
    const recent = turns.slice(-CONTEXT_TURNS * 2);
    const lines = ["[Context from previous conversation]"];
    for (const t of recent) {
      lines.push(`${t.role === "user" ? "User" : "Assistant"}: ${t.text}`);
    }
    lines.push("[End context — continue naturally]");
    return lines.join("\n") + "\n\n";
  }
}
