import Database from "better-sqlite3";

export type CompactionOutcome = "no_turns" | "compacted" | "failed";
export type CompactionErrorCategory =
  | "auth"
  | "capacity"
  | "invalid_output"
  | "provider_unavailable"
  | "timeout"
  | "transient"
  | "unknown";

export interface CompactionAttemptInput {
  chatKey: string;
  trigger: "manual" | "preseed" | "capacity_fallback";
  provider: string;
  model: string | null;
  outcome: CompactionOutcome;
  errorCategory: CompactionErrorCategory | null;
  durationMs: number;
  chunkCount: number;
  cliCallCount: number;
  rangeStartTurnId: number | null;
  rangeEndTurnId: number | null;
  startedAt: string;
  endedAt: string;
}

export interface CompactionAttemptRecord {
  id: number;
  chat_key: string;
  trigger: CompactionAttemptInput["trigger"];
  provider: string;
  model: string | null;
  outcome: CompactionOutcome;
  error_category: CompactionErrorCategory | null;
  duration_ms: number;
  chunk_count: number;
  cli_call_count: number;
  range_start_turn_id: number | null;
  range_end_turn_id: number | null;
  started_at: string;
  ended_at: string;
}

const boundedIdentifier = (value: string | null): string | null => {
  if (value === null) return null;
  const bounded = value.trim().slice(0, 128);
  return /^[a-zA-Z0-9._:/-]+$/.test(bounded) ? bounded : "invalid";
};

const boundedCount = (value: number): number =>
  Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)));

export class CompactionRepository {
  constructor(private readonly db: Database.Database) {}

  addAttempt(input: CompactionAttemptInput): void {
    this.db.prepare(
      `INSERT INTO compaction_attempts (
         chat_key, trigger, provider, model, outcome, error_category,
         duration_ms, chunk_count, cli_call_count, range_start_turn_id,
         range_end_turn_id, started_at, ended_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.chatKey,
      input.trigger,
      boundedIdentifier(input.provider) ?? "invalid",
      boundedIdentifier(input.model),
      input.outcome,
      input.errorCategory,
      boundedCount(input.durationMs),
      boundedCount(input.chunkCount),
      boundedCount(input.cliCallCount),
      input.rangeStartTurnId,
      input.rangeEndTurnId,
      input.startedAt,
      input.endedAt,
    );
  }

  getLatestAttempt(chatKey: string): CompactionAttemptRecord | null {
    return (this.db.prepare(
      `SELECT id, chat_key, trigger, provider, model, outcome, error_category,
              duration_ms, chunk_count, cli_call_count, range_start_turn_id,
              range_end_turn_id, started_at, ended_at
       FROM compaction_attempts WHERE chat_key = ? ORDER BY id DESC LIMIT 1`,
    ).get(chatKey) as CompactionAttemptRecord | undefined) ?? null;
  }
}
