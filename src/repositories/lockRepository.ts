import Database from "better-sqlite3";

export class LockRepository {
  constructor(private readonly db: Database.Database) {}

  tryLock(chatId: string): boolean {
    this.db
      .prepare(`INSERT INTO bridge_state (chat_id) VALUES (?) ON CONFLICT (chat_id) DO NOTHING`)
      .run(chatId);
    const { changes } = this.db
      .prepare(
        `UPDATE bridge_state SET active_execution_lock = 1
         WHERE chat_id = ? AND active_execution_lock = 0`
      )
      .run(chatId);
    return changes === 1;
  }

  unlock(chatId: string): void {
    this.db
      .prepare(`UPDATE bridge_state SET active_execution_lock = 0 WHERE chat_id = ?`)
      .run(chatId);
  }
}
