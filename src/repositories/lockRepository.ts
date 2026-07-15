import Database from "better-sqlite3";

export class LockRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly ownerId = "legacy",
  ) {}

  recoverOwnedLocks(): void {
    this.db.prepare(`DELETE FROM execution_locks WHERE owner_id = ?`).run(this.ownerId);
  }

  tryLock(chatKey: string): boolean;
  tryLock(surface: string, chatKey: string): boolean;
  tryLock(surfaceOrChatKey: string, maybeChatKey?: string): boolean {
    const surface = maybeChatKey === undefined ? "legacy" : surfaceOrChatKey;
    const chatKey = maybeChatKey ?? surfaceOrChatKey;
    const { changes } = this.db
      .prepare(
        `INSERT INTO execution_locks (surface, chat_key, owner_id)
         VALUES (?, ?, ?)
         ON CONFLICT (surface, chat_key) DO NOTHING`
      )
      .run(surface, chatKey, this.ownerId);
    return changes === 1;
  }

  unlock(chatKey: string): void;
  unlock(surface: string, chatKey: string): void;
  unlock(surfaceOrChatKey: string, maybeChatKey?: string): void {
    const surface = maybeChatKey === undefined ? "legacy" : surfaceOrChatKey;
    const chatKey = maybeChatKey ?? surfaceOrChatKey;
    this.db
      .prepare(`DELETE FROM execution_locks WHERE surface = ? AND chat_key = ? AND owner_id = ?`)
      .run(surface, chatKey, this.ownerId);
  }
}
