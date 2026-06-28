import Database from "better-sqlite3";
import type { WorkItem, WorkJob, Approval, GithubLink } from "../db.js";

export class WorkQueueRepository {
  constructor(private readonly db: Database.Database) {}

  // ── Work items ──────────────────────────────────────────────────────────

  createWorkItem(input: {
    kind: string;
    source: string;
    title: string;
    created_by: string;
    repository?: string;
    body?: string;
    priority?: string;
  }): WorkItem {
    const { kind, source, title, created_by, repository = null, body = null, priority = "normal" } = input;
    return this.db.prepare(
      `INSERT INTO work_items (kind, source, title, created_by, repository, body, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    ).get(kind, source, title, created_by, repository, body, priority) as WorkItem;
  }

  getWorkItem(id: number): WorkItem | null {
    return (this.db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(id) as WorkItem | undefined) ?? null;
  }

  listWorkItems(filter: { status?: string } = {}): WorkItem[] {
    if (filter.status) {
      return this.db.prepare(`SELECT * FROM work_items WHERE status = ? ORDER BY id ASC`).all(filter.status) as WorkItem[];
    }
    return this.db.prepare(`SELECT * FROM work_items ORDER BY id ASC`).all() as WorkItem[];
  }

  // ── Work jobs ───────────────────────────────────────────────────────────

  createWorkJob(input: {
    task_type: string;
    idempotency_key: string;
    work_item_id?: number | null;
    bot?: string;
    input_json?: object;
    max_attempts?: number;
  }): WorkJob {
    const { task_type, idempotency_key, work_item_id = null, bot = null, input_json = {}, max_attempts = 2 } = input;
    const existing = this.db.prepare(`SELECT * FROM work_jobs WHERE idempotency_key = ?`).get(idempotency_key) as WorkJob | undefined;
    if (existing) return existing;
    return this.db.prepare(
      `INSERT INTO work_jobs (task_type, idempotency_key, work_item_id, bot, input_json, max_attempts)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    ).get(task_type, idempotency_key, work_item_id, bot, JSON.stringify(input_json), max_attempts) as WorkJob;
  }

  getWorkJob(id: number): WorkJob | null {
    return (this.db.prepare(`SELECT * FROM work_jobs WHERE id = ?`).get(id) as WorkJob | undefined) ?? null;
  }

  claimNextWorkJob(workerId: string, now: string, leaseSeconds: number, jobId?: number): WorkJob | null {
    const expiresAt = new Date(new Date(now).getTime() + leaseSeconds * 1000).toISOString();
    const job = jobId != null
      ? this.db.prepare(
          `SELECT * FROM work_jobs
           WHERE id = ?
             AND (status = 'pending' OR (status IN ('leased','running') AND lease_expires_at < ?))`
        ).get(jobId, now) as WorkJob | undefined
      : this.db.prepare(
          `SELECT * FROM work_jobs
           WHERE status = 'pending'
              OR (status IN ('leased','running') AND lease_expires_at < ?)
           ORDER BY created_at ASC, id ASC
           LIMIT 1`
        ).get(now) as WorkJob | undefined;
    if (!job) return null;
    const { changes } = this.db.prepare(
      `UPDATE work_jobs
       SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND (status = 'pending' OR (status IN ('leased','running') AND lease_expires_at < ?))`
    ).run(workerId, expiresAt, job.id, now);
    if (changes === 0) return null;
    return this.db.prepare(`SELECT * FROM work_jobs WHERE id = ?`).get(job.id) as WorkJob;
  }

  markWorkJobRunning(jobId: number, workerId: string): void {
    this.db.prepare(
      `UPDATE work_jobs SET status = 'running', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND lease_owner = ?`
    ).run(jobId, workerId);
  }

  completeWorkJob(jobId: number, result: object, workerId: string): void {
    this.db.prepare(
      `UPDATE work_jobs
       SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
           result_json = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND lease_owner = ? AND status != 'cancelled'`
    ).run(JSON.stringify(result), jobId, workerId);
  }

  failWorkJob(jobId: number, error: string, workerId: string): void {
    this.db.prepare(
      `UPDATE work_jobs
       SET attempt_count = attempt_count + 1,
           status = CASE WHEN attempt_count + 1 < max_attempts THEN 'pending' ELSE 'failed' END,
           error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND lease_owner = ? AND status != 'cancelled'`
    ).run(error, jobId, workerId);
  }

  failWorkJobPermanently(jobId: number, error: string, workerId: string): void {
    this.db.prepare(
      `UPDATE work_jobs
       SET status = 'failed', error = ?, lease_owner = NULL, lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND lease_owner = ? AND status != 'cancelled'`
    ).run(error, jobId, workerId);
  }

  cancelWorkJob(jobId: number, _reason: string): void {
    this.db.prepare(
      `UPDATE work_jobs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(jobId);
  }

  recoverExpiredWorkJobs(now: string): number {
    const { changes } = this.db.prepare(
      `UPDATE work_jobs
       SET status = CASE WHEN attempt_count < max_attempts THEN 'pending' ELSE 'failed' END,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE status IN ('leased','running') AND lease_expires_at < ?`
    ).run(now);
    return changes;
  }

  // ── Approvals ──────────────────────────────────────────────────────────

  createApproval(input: {
    approval_type: string;
    requested_by: string;
    work_item_id?: number | null;
    job_id?: number | null;
    expires_at?: string | null;
    payload?: object;
  }): Approval {
    const { approval_type, requested_by, work_item_id = null, job_id = null, expires_at = null, payload = {} } = input;
    return this.db.prepare(
      `INSERT INTO approvals (approval_type, requested_by, work_item_id, job_id, expires_at, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    ).get(approval_type, requested_by, work_item_id, job_id, expires_at, JSON.stringify(payload)) as Approval;
  }

  resolveApproval(id: number, decision: "approved" | "rejected", decidedBy: string, now: string = new Date().toISOString()): Approval {
    this.db.prepare(
      `UPDATE approvals SET status = 'expired'
       WHERE id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`
    ).run(id, now);
    this.db.prepare(
      `UPDATE approvals
       SET status = ?, decided_by = ?, decided_at = ?
       WHERE id = ? AND status = 'pending'`
    ).run(decision, decidedBy, now, id);
    return this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as Approval;
  }

  // ── GitHub links ───────────────────────────────────────────────────────

  linkGithubIssue(input: { work_item_id: number; repository: string; issue_number: number }): GithubLink {
    const { work_item_id, repository, issue_number } = input;
    return this.db.prepare(
      `INSERT INTO github_links (work_item_id, repository, issue_number)
       VALUES (?, ?, ?)
       RETURNING *`
    ).get(work_item_id, repository, issue_number) as GithubLink;
  }

  linkGithubPr(input: { work_item_id: number; repository: string; pr_number: number; branch_name?: string; commit_sha?: string }): GithubLink {
    const { work_item_id, repository, pr_number, branch_name = null, commit_sha = null } = input;
    return this.db.prepare(
      `INSERT INTO github_links (work_item_id, repository, pr_number, branch_name, commit_sha)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`
    ).get(work_item_id, repository, pr_number, branch_name, commit_sha) as GithubLink;
  }

  updatePrState(linkId: number, state: string): void {
    this.db.prepare(
      `UPDATE github_links SET pr_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(state, linkId);
  }

  listOpenAgentPrs(repository: string): GithubLink[] {
    return this.db.prepare(
      `SELECT * FROM github_links
       WHERE repository = ? AND pr_number IS NOT NULL
         AND pr_state NOT IN ('merged','closed')
       ORDER BY id ASC`
    ).all(repository) as GithubLink[];
  }
}
