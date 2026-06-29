import Database from "better-sqlite3";

export class RunRepository {
  constructor(private readonly db: Database.Database) {}

  insertRun(runId: string, chatId: string, bot: string): void {
    const startedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO bridge_runs (run_id, chat_id, bot, status, started_at)
         VALUES (?, ?, ?, 'running', ?)`
      )
      .run(runId, chatId, bot, startedAt);
  }

  getRun(runId: string): any {
    return this.db
      .prepare(`SELECT * FROM bridge_runs WHERE run_id = ?`)
      .get(runId);
  }

  updateRunCompleted(runId: string, text: string, sessionId: string | null): void {
    const endedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE bridge_runs
         SET status = 'done', ended_at = ?, final_text_preview = ?, session_id = ?
         WHERE run_id = ?`
      )
      .run(endedAt, text, sessionId, runId);
  }

  updateRunFailed(runId: string, error: string): void {
    const endedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE bridge_runs
         SET status = 'failed', ended_at = ?, error = ?
         WHERE run_id = ?`
      )
      .run(endedAt, error, runId);
  }

  updateRunCancelled(runId: string, reason: string): void {
    const endedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE bridge_runs
         SET status = 'cancelled', ended_at = ?, error = ?
         WHERE run_id = ?`
      )
      .run(endedAt, reason, runId);
  }

  insertEvent(runId: string, seq: number, type: string, timestamp: string, payload: any): void {
    const id = `${runId}:${seq}`;
    const payloadJson = JSON.stringify(payload);
    this.db
      .prepare(
        `INSERT INTO bridge_events (id, run_id, seq, type, timestamp, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, runId, seq, type, timestamp, payloadJson);
  }

  getEventsForRun(runId: string): any[] {
    return this.db
      .prepare(`SELECT * FROM bridge_events WHERE run_id = ? ORDER BY seq ASC`)
      .all(runId);
  }

  cleanupOrphanedRuns(onOrphan: (run: { run_id: string; chat_id: string; bot: string }) => void | Promise<void>): void {
    const endedAt = new Date().toISOString();
    const orphans = this.db
      .prepare(`SELECT run_id, chat_id, bot FROM bridge_runs WHERE status = 'running'`)
      .all() as Array<{ run_id: string; chat_id: string; bot: string }>;

    for (const run of orphans) {
      this.db
        .prepare(
          `UPDATE bridge_runs
           SET status = 'failed', ended_at = ?, error = 'Process interrupted by bridge restart'
           WHERE run_id = ?`
        )
        .run(endedAt, run.run_id);

      try {
        onOrphan(run);
      } catch (err) {
        console.error(`Failed to handle orphaned run ${run.run_id}`, err);
      }
    }
  }
}
