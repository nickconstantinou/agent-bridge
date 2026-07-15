import Database from "better-sqlite3";

export interface LockRepositoryOptions {
  serviceId: string;
  runId: string;
  leaseMs: number;
  clock?: () => number;
}

export class LockRepository {
  private readonly now: () => number;

  constructor(
    private readonly db: Database.Database,
    private readonly options: LockRepositoryOptions,
  ) {
    this.now = options.clock ?? Date.now;
  }

  tryLock(surface: string, chatKey: string): boolean {
    const now = this.now();
    const acquiredAt = new Date(now).toISOString();
    const leaseExpiresAt = new Date(now + this.options.leaseMs).toISOString();
    const { changes } = this.db.prepare(`
      INSERT INTO execution_locks (surface, chat_key, service_id, run_id, acquired_at, lease_expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (surface, chat_key) DO UPDATE SET
        service_id = excluded.service_id,
        run_id = excluded.run_id,
        acquired_at = excluded.acquired_at,
        lease_expires_at = excluded.lease_expires_at
      WHERE execution_locks.lease_expires_at <= excluded.acquired_at
    `).run(surface, chatKey, this.options.serviceId, this.options.runId, acquiredAt, leaseExpiresAt);
    return changes === 1;
  }

  heartbeat(surface: string, chatKey: string): boolean {
    const leaseExpiresAt = new Date(this.now() + this.options.leaseMs).toISOString();
    const { changes } = this.db.prepare(`
      UPDATE execution_locks
      SET lease_expires_at = ?
      WHERE surface = ? AND chat_key = ? AND service_id = ? AND run_id = ?
    `).run(leaseExpiresAt, surface, chatKey, this.options.serviceId, this.options.runId);
    return changes === 1;
  }

  unlock(surface: string, chatKey: string): void {
    this.db.prepare(`
      DELETE FROM execution_locks
      WHERE surface = ? AND chat_key = ? AND service_id = ? AND run_id = ?
    `).run(surface, chatKey, this.options.serviceId, this.options.runId);
  }
}
