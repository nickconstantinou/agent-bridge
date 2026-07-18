import type Database from "better-sqlite3";

export interface ReserveAdvisorCallInput {
  requestId: string;
  scopeKey: string;
  turnKey?: string;
  taskKey?: string;
  mode: string;
  trigger: string;
  contextChars: number;
  maxCallsPerTurn: number;
  maxCallsPerTask: number;
}

export interface AddAdvisorAttemptInput {
  requestId: string;
  ordinal: number;
  provider: string;
  model: string;
  status: string;
  errorKind?: string;
  durationMs: number;
}

/**
 * Connection-bound SQL owner for advisor_calls/advisor_attempts. Does not
 * independently begin transactions — reserveAdvisorCall's dedup-and-limit
 * check must run atomically, so it wraps its own statements in db.transaction()
 * exactly as the pre-extraction BridgeDb method did; every other method here
 * is a single statement with no transaction of its own.
 */
export class AdvisorRepository {
  constructor(private readonly db: Database.Database) {}

  reserveAdvisorCall(input: ReserveAdvisorCallInput): boolean {
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT status FROM advisor_calls WHERE request_id = ?").get(input.requestId);
      if (existing) return false;
      if (input.turnKey) {
        const row = this.db.prepare("SELECT COUNT(*) AS n FROM advisor_calls WHERE turn_key = ? AND status != 'denied'").get(input.turnKey) as { n: number };
        if (row.n >= input.maxCallsPerTurn) return false;
      }
      if (input.taskKey) {
        const row = this.db.prepare("SELECT COUNT(*) AS n FROM advisor_calls WHERE task_key = ? AND status != 'denied'").get(input.taskKey) as { n: number };
        if (row.n >= input.maxCallsPerTask) return false;
      }
      this.db.prepare(`INSERT INTO advisor_calls
        (request_id, scope_key, turn_key, task_key, mode, trigger, status, context_chars)
        VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`)
        .run(input.requestId, input.scopeKey, input.turnKey ?? null, input.taskKey ?? null, input.mode, input.trigger, input.contextChars);
      return true;
    })();
  }

  addAdvisorAttempt(input: AddAdvisorAttemptInput): void {
    this.db.prepare(`INSERT INTO advisor_attempts
      (request_id, ordinal, provider, model, status, error_kind, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.requestId, input.ordinal, input.provider, input.model, input.status, input.errorKind ?? null, input.durationMs);
  }

  completeAdvisorCall(requestId: string, provider: string, model: string, confidence: string): void {
    this.db.prepare(`UPDATE advisor_calls SET status='succeeded', selected_provider=?, selected_model=?, confidence=?, updated_at=CURRENT_TIMESTAMP WHERE request_id=?`)
      .run(provider, model, confidence, requestId);
  }

  failAdvisorCall(requestId: string, errorKind: string): void {
    this.db.prepare(`UPDATE advisor_calls SET status='failed', error_kind=?, updated_at=CURRENT_TIMESTAMP WHERE request_id=?`)
      .run(errorKind, requestId);
  }

  getAdvisorAttempts(requestId: string): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM advisor_attempts WHERE request_id = ? ORDER BY ordinal").all(requestId) as Array<Record<string, unknown>>;
  }
}
