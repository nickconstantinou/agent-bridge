/**
 * PURPOSE: SQLite database storage interface and migration definitions for Agent Bridge state.
 * INPUTS: Database file paths, chat IDs, bot types, and session tokens.
 * OUTPUTS: Active session IDs, locks, update indices, and model overrides.
 * NEIGHBORS: src/index.ts, src/bridge.ts
 * LOGIC: Executes DDL schema checks, implements migrations for new columns, and exposes parameterized CRUD operations on the SQLite backend.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LockRepository, type ExecutionLaneHandle } from "./repositories/lockRepository.js";
export type { ExecutionLaneHandle } from "./repositories/lockRepository.js";
import { MemoryRepository } from "./repositories/memoryRepository.js";
import { RunRepository } from "./repositories/runRepository.js";
import { SessionRepository } from "./repositories/sessionRepository.js";
import { SettingsRepository } from "./repositories/settingsRepository.js";
import { WorkQueueRepository } from "./repositories/workQueueRepository.js";
import {
  CompactionRepository,
  type CompactionAttemptInput,
  type CompactionAttemptRecord,
} from "./repositories/compactionRepository.js";
import { applyMigrations, CURRENT_SCHEMA_VERSION, UnsupportedSchemaVersionError } from "./db/schema.js";

// Sentinel row keys stored in bridge_state for non-chat state
const pollingKey = (bot: string) => `$polling:${bot}`;
export const DEFAULT_CONTEXT_MAX_CHARS = 8_000;
export const DEFAULT_CONTEXT_RECENT_TURN_LIMIT = 200;

function recentTurnCandidateLimit(): number {
  const raw = process.env.BRIDGE_CONTEXT_RECENT_TURN_LIMIT;
  if (!raw) return DEFAULT_CONTEXT_RECENT_TURN_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_RECENT_TURN_LIMIT;
}

const MEMORY_SYNONYMS: Record<string, string[]> = {
  affordance: ["helper", "command", "context"],
  compact: ["compact", "compaction", "summary", "summarise", "summarize"],
  compaction: ["compact", "compaction", "summary", "summarise", "summarize"],
  context: ["context", "conversation", "history", "turns"],
  fallback: ["fallback", "switch", "promotion", "persistent", "preference"],
  histories: ["history", "conversation", "context", "turns"],
  history: ["history", "conversation", "context", "turns"],
  memory: ["memory", "memories", "remember", "recall"],
  memories: ["memory", "memories", "remember", "recall"],
  persistent: ["persistent", "preference", "fallback", "promotion"],
  promote: ["promotion", "fallback", "switch", "persistent"],
  promotion: ["promotion", "fallback", "switch", "persistent"],
  summaries: ["summary", "summaries", "summarise", "summarize", "compact", "compaction"],
  summarisation: ["summary", "summaries", "summarise", "summarize", "compact", "compaction"],
  summarization: ["summary", "summaries", "summarise", "summarize", "compact", "compaction"],
  summary: ["summary", "summaries", "summarise", "summarize", "compact", "compaction"],
  switch: ["switch", "fallback", "promotion", "persistent"],
};

function normalizeMemoryTokens(raw: string): string[] {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const tokens = new Set<string>();
  for (const word of base) {
    tokens.add(word);
    if (word.endsWith("ies") && word.length > 4) tokens.add(`${word.slice(0, -3)}y`);
    if (word.endsWith("s") && word.length > 4) tokens.add(word.slice(0, -1));
    for (const alias of MEMORY_SYNONYMS[word] ?? []) tokens.add(alias);
  }
  return [...tokens].slice(0, 32);
}

export function buildMemoryFtsQuery(raw: string): string {
  return normalizeMemoryTokens(raw).map((w) => `${w}*`).join(" OR ");
}

function assertExecutionScope(surface: string, chatKey: string): void {
  if (!surface?.trim()) throw new Error("surface is required");
  if (!chatKey?.trim()) throw new Error("chatKey is required");
}

export interface OpenDbOptions {
  /** Stable across configuration changes and restarts. */
  serviceId?: string;
  /** Unique to one live process generation. */
  runId?: string;
  lockLeaseMs?: number;
  /** Test-only clock injection for deterministic lease expiry. */
  clock?: () => number;
}

export class ExecutionLockLostError extends Error {
  constructor() { super("execution lock ownership lost"); }
}

export function openDb(dbPath: string, options: OpenDbOptions = {}): BridgeDb {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const raw = new Database(dbPath);
  // Version-gate before WAL mode or any other write-affecting operation, so a
  // future, negative, or otherwise unsupported database is rejected without
  // being mutated. Mirrors the validation in applyMigrationsUpTo() so no
  // invalid version can reach WAL mode via this earlier gate.
  const schemaVersion = Number(raw.pragma("user_version", { simple: true }));
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0 || schemaVersion > CURRENT_SCHEMA_VERSION) {
    raw.close();
    throw new UnsupportedSchemaVersionError(schemaVersion);
  }
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  applyMigrations(raw);

  // ── Non-schema runtime maintenance ────────────────────────────────────────
  // Prunes turns already covered by a compact summary. Depends on runtime
  // data (conversation_summaries), not schema shape, so it must run on every
  // open rather than once via migration.
  raw.exec(`
    DELETE FROM conversation_turns
    WHERE id <= COALESCE((
      SELECT MAX(range_end_turn_id)
      FROM conversation_summaries
      WHERE chat_key = conversation_turns.chat_key
    ), 0)
  `);

  // Expire sessions older than 7 days — prevents a stale/corrupt session from
  // being resumed indefinitely after a long gap without a /reset
  for (const bot of ["codex", "antigravity", "claude"] as const) {
    raw.exec(
      `UPDATE bridge_state
       SET ${bot}_session_id = NULL, ${bot}_session_created_at = NULL
       WHERE ${bot}_session_created_at IS NOT NULL
         AND ${bot}_session_created_at < datetime('now', '-7 days')`
    );
  }
  const leaseMs = options.lockLeaseMs ?? 90_000;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("lockLeaseMs must be greater than zero");
  return new BridgeDb(raw, {
    serviceId: options.serviceId ?? "diagnostic",
    runId: options.runId ?? randomUUID(),
    leaseMs,
    clock: options.clock,
  });
}

export class BridgeDb {
  readonly raw: Database.Database;
  readonly lockHeartbeatMs: number;
  private readonly sessions: SessionRepository;
  private readonly locks: LockRepository;
  private readonly settings: SettingsRepository;
  private readonly runs: RunRepository;
  private readonly workQueue: WorkQueueRepository;
  private readonly memories: MemoryRepository;
  private readonly compactions: CompactionRepository;

  constructor(raw: Database.Database, lockOptions: {
    serviceId: string; runId: string; leaseMs: number; clock?: () => number;
  } = { serviceId: "diagnostic", runId: randomUUID(), leaseMs: 90_000 }) {
    this.raw = raw;
    this.sessions = new SessionRepository(raw);
    this.locks = new LockRepository(raw, lockOptions);
    this.lockHeartbeatMs = Math.max(100, Math.floor(lockOptions.leaseMs / 3));
    this.settings = new SettingsRepository(raw);
    this.runs = new RunRepository(raw);
    this.workQueue = new WorkQueueRepository(raw);
    this.memories = new MemoryRepository(raw);
    this.compactions = new CompactionRepository(raw);
  }

  runInTransaction<T>(operation: () => T): T {
    return this.raw.transaction(operation)();
  }

  runWithLockFence<T>(handle: ExecutionLaneHandle, operation: () => T): T {
    assertExecutionScope(handle.surface, handle.chatKey);
    return this.runInTransaction(() => {
      if (!this.locks.heartbeat(handle)) throw new ExecutionLockLostError();
      return operation();
    });
  }

  // ── Session management ───────────────────────────────────────────────────

  getSession(chatId: string, bot: "codex" | "antigravity" | "claude" | "kimchi"): string | null {
    return this.sessions.getSession(chatId, bot);
  }

  setSession(chatId: string, bot: "codex" | "antigravity" | "claude" | "kimchi", sessionId: string | null): void {
    this.sessions.setSession(chatId, bot, sessionId);
  }

  // ── Per-chat execution lock ──────────────────────────────────────────────

  acquireLock(surface: string, chatKey: string): ExecutionLaneHandle | null {
    assertExecutionScope(surface, chatKey);
    return this.locks.acquire(surface, chatKey);
  }

  heartbeatLock(handle: ExecutionLaneHandle): boolean {
    return this.locks.heartbeat(handle);
  }

  ownsLock(handle: ExecutionLaneHandle): boolean {
    return this.locks.owns(handle);
  }

  unlock(handle: ExecutionLaneHandle): boolean {
    return this.locks.unlock(handle);
  }

  // ── Global polling offset (per bot kind) ────────────────────────────────

  getLastUpdateId(bot: "codex" | "antigravity" | "claude" | "kimchi"): number {
    return this.settings.getLastUpdateId(bot);
  }

  setLastUpdateId(bot: "codex" | "antigravity" | "claude" | "kimchi", updateId: number): void {
    this.settings.setLastUpdateId(bot, updateId);
  }

  // ── Model-override settings ──────────────────────────────────────────────

  getSetting(key: string): string | null {
    return this.settings.getSetting(key);
  }

  // ── Session failure circuit breaker ─────────────────────────────────────

  incrementFailures(chatId: string, bot: "codex" | "antigravity" | "claude" | "kimchi"): number {
    return this.settings.incrementFailures(chatId, bot);
  }

  resetFailures(chatId: string, bot: "codex" | "antigravity" | "claude" | "kimchi"): void {
    this.settings.resetFailures(chatId, bot);
  }

  getMaxConsecutiveFailures(): { bot: string; count: number }[] {
    return this.settings.getMaxConsecutiveFailures();
  }

  setSetting(key: string, value: string | null): void {
    this.settings.setSetting(key, value);
  }

  reserveAdvisorCall(input: {
    requestId: string; scopeKey: string; turnKey?: string; taskKey?: string;
    mode: string; trigger: string; contextChars: number;
    maxCallsPerTurn: number; maxCallsPerTask: number;
  }): boolean {
    return this.raw.transaction(() => {
      const existing = this.raw.prepare("SELECT status FROM advisor_calls WHERE request_id = ?").get(input.requestId);
      if (existing) return false;
      if (input.turnKey) {
        const row = this.raw.prepare("SELECT COUNT(*) AS n FROM advisor_calls WHERE turn_key = ? AND status != 'denied'").get(input.turnKey) as { n: number };
        if (row.n >= input.maxCallsPerTurn) return false;
      }
      if (input.taskKey) {
        const row = this.raw.prepare("SELECT COUNT(*) AS n FROM advisor_calls WHERE task_key = ? AND status != 'denied'").get(input.taskKey) as { n: number };
        if (row.n >= input.maxCallsPerTask) return false;
      }
      this.raw.prepare(`INSERT INTO advisor_calls
        (request_id, scope_key, turn_key, task_key, mode, trigger, status, context_chars)
        VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`)
        .run(input.requestId, input.scopeKey, input.turnKey ?? null, input.taskKey ?? null, input.mode, input.trigger, input.contextChars);
      return true;
    })();
  }

  addAdvisorAttempt(input: {
    requestId: string; ordinal: number; provider: string; model: string;
    status: string; errorKind?: string; durationMs: number;
  }): void {
    this.raw.prepare(`INSERT INTO advisor_attempts
      (request_id, ordinal, provider, model, status, error_kind, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.requestId, input.ordinal, input.provider, input.model, input.status, input.errorKind ?? null, input.durationMs);
  }

  completeAdvisorCall(requestId: string, provider: string, model: string, confidence: string): void {
    this.raw.prepare(`UPDATE advisor_calls SET status='succeeded', selected_provider=?, selected_model=?, confidence=?, updated_at=CURRENT_TIMESTAMP WHERE request_id=?`)
      .run(provider, model, confidence, requestId);
  }

  failAdvisorCall(requestId: string, errorKind: string): void {
    this.raw.prepare(`UPDATE advisor_calls SET status='failed', error_kind=?, updated_at=CURRENT_TIMESTAMP WHERE request_id=?`)
      .run(errorKind, requestId);
  }

  getAdvisorAttempts(requestId: string): Array<Record<string, unknown>> {
    return this.raw.prepare("SELECT * FROM advisor_attempts WHERE request_id = ? ORDER BY ordinal").all(requestId) as Array<Record<string, unknown>>;
  }

  getChatRepo(chatId: string): string | null {
    return this.settings.getChatRepo(chatId);
  }

  setChatRepo(chatId: string, repo: string | null): void {
    this.settings.setChatRepo(chatId, repo);
  }

  insertRun(
    runId: string,
    chatId: string,
    bot: string,
  ): void {
    this.runs.insertRun(runId, chatId, bot);
  }

  getRun(runId: string): any {
    return this.runs.getRun(runId);
  }

  updateRunCompleted(runId: string, text: string, sessionId: string | null): void {
    this.runs.updateRunCompleted(runId, text, sessionId);
  }

  updateRunFailed(runId: string, error: string): void {
    this.runs.updateRunFailed(runId, error);
  }

  updateRunCancelled(runId: string, reason: string): void {
    this.runs.updateRunCancelled(runId, reason);
  }

  insertEvent(runId: string, seq: number, type: string, timestamp: string, payload: any): void {
    this.runs.insertEvent(runId, seq, type, timestamp, payload);
  }

  getEventsForRun(runId: string): any[] {
    return this.runs.getEventsForRun(runId);
  }

  // ── Work items ───────────────────────────────────────────────────────────

  createWorkItem(input: {
    kind: string;
    source: string;
    title: string;
    created_by: string;
    repository?: string;
    body?: string;
    priority?: string;
  }): WorkItem {
    return this.workQueue.createWorkItem(input);
  }

  getWorkItem(id: number): WorkItem | null {
    return this.workQueue.getWorkItem(id);
  }

  listWorkItems(filter: { status?: string } = {}): WorkItem[] {
    return this.workQueue.listWorkItems(filter);
  }

  updateWorkItemStatus(id: number, status: string): void {
    this.workQueue.updateWorkItemStatus(id, status);
  }

  updateWorkItemBody(id: number, body: string): void {
    this.workQueue.updateWorkItemBody(id, body);
  }

  updateWorkItemTitleAndBody(id: number, title: string, body: string | null): void {
    this.workQueue.updateWorkItemTitleAndBody(id, title, body);
  }

  // ── Work jobs ────────────────────────────────────────────────────────────

  createWorkJob(input: {
    task_type: string;
    idempotency_key: string;
    work_item_id?: number | null;
    bot?: string;
    input_json?: object;
    max_attempts?: number;
  }): WorkJob {
    return this.workQueue.createWorkJob(input);
  }

  getWorkJob(id: number): WorkJob | null {
    return this.workQueue.getWorkJob(id);
  }

  listWorkJobs(filter: { status?: string } = {}): WorkJob[] {
    return this.workQueue.listWorkJobs(filter);
  }

  // ── Job lease lifecycle ──────────────────────────────────────────────────

  claimNextWorkJob(workerId: string, now: string, leaseSeconds: number, jobId?: number): WorkJob | null {
    return this.workQueue.claimNextWorkJob(workerId, now, leaseSeconds, jobId);
  }

  markWorkJobRunning(jobId: number, workerId: string): void {
    this.workQueue.markWorkJobRunning(jobId, workerId);
  }

  heartbeatWorkJob(jobId: number, workerId: string, now: string, leaseSeconds?: number): void {
    this.workQueue.heartbeatWorkJob(jobId, workerId, now, leaseSeconds);
  }

  completeWorkJob(jobId: number, result: object, workerId: string): void {
    this.workQueue.completeWorkJob(jobId, result, workerId);
  }

  failWorkJob(jobId: number, error: string, workerId: string): void {
    this.workQueue.failWorkJob(jobId, error, workerId);
  }

  failWorkJobPermanently(jobId: number, error: string, workerId: string): void {
    this.workQueue.failWorkJobPermanently(jobId, error, workerId);
  }

  /** Re-queue a job as pending with an updated phase and phaseData checkpoint. */
  continueWorkJob(jobId: number, phase: string, phaseData: object, workerId: string): void {
    this.workQueue.continueWorkJob(jobId, phase, phaseData, workerId);
  }

  recoverExpiredWorkJobs(now: string): number {
    return this.workQueue.recoverExpiredWorkJobs(now);
  }

  cancelWorkJob(jobId: number, _reason: string): void {
    this.workQueue.cancelWorkJob(jobId, _reason);
  }

  // ── Approvals ────────────────────────────────────────────────────────────

  createApproval(input: {
    approval_type: string;
    requested_by: string;
    work_item_id?: number | null;
    job_id?: number | null;
    expires_at?: string | null;
    payload?: object;
  }): Approval {
    return this.workQueue.createApproval(input);
  }

  resolveApproval(id: number, decision: "approved" | "rejected", decidedBy: string, now: string = new Date().toISOString()): Approval {
    return this.workQueue.resolveApproval(id, decision, decidedBy, now);
  }

  // ── GitHub links ─────────────────────────────────────────────────────────

  linkGithubIssue(input: { work_item_id: number; repository: string; issue_number: number }): GithubLink {
    return this.workQueue.linkGithubIssue(input);
  }

  getGithubIssueLink(repository: string, issueNumber: number): GithubLink | null {
    return this.workQueue.getGithubIssueLink(repository, issueNumber);
  }

  linkGithubPr(input: { work_item_id: number; repository: string; pr_number: number; branch_name?: string; commit_sha?: string }): GithubLink {
    return this.workQueue.linkGithubPr(input);
  }

  updatePrState(linkId: number, state: string): void {
    this.workQueue.updatePrState(linkId, state);
  }

  listOpenAgentPrs(repository: string): GithubLink[] {
    return this.workQueue.listOpenAgentPrs(repository);
  }

  listAllOpenAgentPrs(): GithubLink[] {
    return this.workQueue.listAllOpenAgentPrs();
  }

  touchPrActivity(linkId: number, ts: string): void {
    this.workQueue.touchPrActivity(linkId, ts);
  }

  setProofCommentSha(linkId: number, sha: string): void {
    this.workQueue.setProofCommentSha(linkId, sha);
  }

  countDailyAgentPrs(repository: string): number {
    return this.workQueue.countDailyAgentPrs(repository);
  }

  // ── Feature plans ────────────────────────────────────────────────────────

  createFeaturePlan(input: { chatId: string; userId: string; brief: string }): FeaturePlan {
    const { chatId, userId, brief } = input;
    // Cancel any existing drafting plan for this chat before creating a new one
    this.raw.prepare(
      `UPDATE feature_plans SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE chat_id = ? AND status = 'drafting'`
    ).run(chatId);
    return this.raw.prepare(
      `INSERT INTO feature_plans (chat_id, user_id, brief) VALUES (?, ?, ?) RETURNING *`
    ).get(chatId, userId, brief) as FeaturePlan;
  }

  getFeaturePlan(id: number): FeaturePlan | null {
    return (this.raw.prepare(`SELECT * FROM feature_plans WHERE id = ?`).get(id) as FeaturePlan | undefined) ?? null;
  }

  getActivePlanForChat(chatId: string): FeaturePlan | null {
    return (this.raw.prepare(
      `SELECT * FROM feature_plans WHERE chat_id = ? AND status = 'drafting' ORDER BY id DESC LIMIT 1`
    ).get(chatId) as FeaturePlan | undefined) ?? null;
  }

  updateFeaturePlanStatus(id: number, status: string): void {
    this.raw.prepare(
      `UPDATE feature_plans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(status, id);
  }

  updateFeaturePlanScope(id: number, scope: object): void {
    this.raw.prepare(
      `UPDATE feature_plans SET scope_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(JSON.stringify(scope), id);
  }

  setWorkItemPlan(workItemId: number, planText: string, quality: object = {}): WorkItemPlan {
    return this.raw.prepare(
      `INSERT INTO work_item_plans (work_item_id, plan_text, quality_json)
       VALUES (?, ?, ?)
       ON CONFLICT(work_item_id) DO UPDATE SET
         plan_text = excluded.plan_text,
         quality_json = excluded.quality_json,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`
    ).get(workItemId, planText, JSON.stringify(quality)) as WorkItemPlan;
  }

  getWorkItemPlan(workItemId: number): WorkItemPlan | null {
    return (this.raw.prepare(
      `SELECT * FROM work_item_plans WHERE work_item_id = ? LIMIT 1`
    ).get(workItemId) as WorkItemPlan | undefined) ?? null;
  }

  cleanupOrphanedRuns(onOrphan: (run: { run_id: string; chat_id: string; bot: string }) => void | Promise<void>): void {
    this.runs.cleanupOrphanedRuns(onOrphan);
  }

  // ── Conversation turns ──────────────────────────────────────────────────
  addConvTurn(chatKey: string, role: "user" | "assistant", text: string, cli?: string): void {
    this.raw
      .prepare(`INSERT INTO conversation_turns (chat_key, role, text, cli) VALUES (?, ?, ?, ?)`)
      .run(chatKey, role, text, cli ?? null);
  }

  getRecentConvTurns(
    chatKey: string,
    limit: number,
    sinceId?: number,
  ): Array<{ id: number; role: string; text: string; cli: string | null; created_at: string }> {
    if (sinceId != null) {
      // Fetch the newest `limit` turns after sinceId (not the oldest), then
      // re-sort chronologically — mirrors the no-summary branch below so the
      // most recent context is never silently dropped once a chat exceeds
      // the candidate limit.
      return this.raw
        .prepare(
          `SELECT id, role, text, cli, created_at FROM (
             SELECT id, role, text, cli, created_at FROM conversation_turns
             WHERE chat_key = ? AND id > ?
             ORDER BY id DESC LIMIT ?
           ) ORDER BY id ASC`
        )
        .all(chatKey, sinceId, limit) as any;
    }
    return this.raw
      .prepare(
        `SELECT id, role, text, cli, created_at FROM (
           SELECT id, role, text, cli, created_at FROM conversation_turns
           WHERE chat_key = ?
           ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`
      )
      .all(chatKey, limit) as any;
  }

  buildConvContext(chatKey: string, maxChars = DEFAULT_CONTEXT_MAX_CHARS): string {
    const summary = this.getLatestConvSummary(chatKey);
    const sinceId = summary?.range_end_turn_id;
    // Fetch the newest N candidates (configurable via BRIDGE_CONTEXT_RECENT_TURN_LIMIT);
    // char budget below further culls them. This is a prompt-context cap only —
    // compaction (getConvTurnsForCompaction) always processes the full backlog.
    const candidates = this.getRecentConvTurns(chatKey, recentTurnCandidateLimit(), sinceId);
    if (!summary && candidates.length === 0) return "";

    // Walk newest-first, accumulate until char budget is exhausted
    let budget = maxChars - (summary ? summary.summary_md.length : 0);
    const selected: Array<{ role: string; text: string }> = [];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const t = candidates[i];
      const line = `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`;
      if (line.length <= budget) {
        selected.unshift({ role: t.role, text: t.text });
        budget -= line.length;
      }
    }

    const lines = ["[Context from previous conversation]"];
    if (summary) {
      lines.push(summary.summary_md);
      lines.push("");
    }
    for (const t of selected) {
      lines.push(`${t.role === "user" ? "User" : "Assistant"}: ${t.text}`);
    }
    lines.push("[End context — continue naturally]");
    return lines.join("\n") + "\n\n";
  }

  // ── Pending messages ────────────────────────────────────────────────────
  pendingMsgCount(surface: string, chatKey: string): number {
    assertExecutionScope(surface, chatKey);
    const row = this.raw
      .prepare(`SELECT COUNT(*) AS n FROM pending_messages WHERE surface = ? AND chat_key = ?`)
      .get(surface, chatKey) as { n: number };
    return row.n;
  }

  enqueueMsg(
    surface: string,
    chatKey: string,
    msg: { prompt: string; chatId: number; threadId?: number; chatType: string; userId?: number; attachments?: string[] },
  ): void {
    assertExecutionScope(surface, chatKey);
    this.raw
      .prepare(
        `INSERT INTO pending_messages (surface, chat_key, prompt, chat_id, thread_id, chat_type, user_id, attachments_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(surface, chatKey, msg.prompt, msg.chatId, msg.threadId ?? null, msg.chatType, msg.userId ?? null, JSON.stringify(msg.attachments ?? []));
  }

  dequeueMsgs(surface: string, chatKey: string): Array<{
    id: number; prompt: string; chatId: number; threadId: number | null; chatType: string; userId: number | null; attachments: string[];
  }> {
    assertExecutionScope(surface, chatKey);
    return (this.raw
      .prepare(`SELECT id, prompt, chat_id AS chatId, thread_id AS threadId, chat_type AS chatType, user_id AS userId,
                       attachments_json AS attachmentsJson
                FROM pending_messages WHERE surface = ? AND chat_key = ? ORDER BY id ASC`)
      .all(surface, chatKey) as any[]).map(({ attachmentsJson, ...row }) => ({ ...row, attachments: JSON.parse(attachmentsJson || "[]") }));
  }

  deletePendingMsg(id: number): void {
    this.raw.prepare(`DELETE FROM pending_messages WHERE id = ?`).run(id);
  }

  claimNextPendingMsg(handle: ExecutionLaneHandle): {
    id: number; chatKey: string; prompt: string; chatId: number; threadId: number | null; chatType: string; userId: number | null; attachments: string[];
  } | null {
    const { surface, chatKey } = handle;
    assertExecutionScope(surface, chatKey);
    return this.runInTransaction(() => {
      if (!this.ownsLock(handle)) return null;
      this.raw.prepare(`
        UPDATE pending_messages SET state = 'queued', claim_run_id = NULL, claim_acquisition_id = NULL, claimed_at = NULL
        WHERE surface = ? AND chat_key = ? AND state = 'claimed' AND (claim_run_id IS NOT ? OR claim_acquisition_id IS NOT ?)
      `).run(surface, chatKey, handle.runId, handle.acquisitionId);
      const active = this.raw.prepare(`
        SELECT 1 FROM pending_messages
        WHERE surface = ? AND chat_key = ? AND state = 'claimed' AND claim_run_id = ? AND claim_acquisition_id = ? LIMIT 1
      `).get(surface, chatKey, handle.runId, handle.acquisitionId);
      if (active) return null;
      const row = this.raw.prepare(`
        SELECT id, chat_key AS chatKey, prompt, chat_id AS chatId, thread_id AS threadId, chat_type AS chatType, user_id AS userId,
               attachments_json AS attachmentsJson
        FROM pending_messages WHERE surface = ? AND chat_key = ? AND state = 'queued' ORDER BY id ASC LIMIT 1
      `).get(surface, chatKey) as any;
      if (!row) return null;
      const changed = this.raw.prepare(`
        UPDATE pending_messages SET state = 'claimed', claim_run_id = ?, claim_acquisition_id = ?, claimed_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(handle.runId, handle.acquisitionId, new Date().toISOString(), row.id).changes;
      if (changed !== 1) return null;
      const { attachmentsJson, ...claimed } = row;
      return { ...claimed, attachments: JSON.parse(attachmentsJson || "[]") };
    });
  }

  completePendingMsg(handle: ExecutionLaneHandle, id: number): boolean {
    const { surface, chatKey } = handle;
    assertExecutionScope(surface, chatKey);
    return this.runInTransaction(() => {
      if (!this.locks.owns(handle)) return false;
      return this.raw.prepare(`
        DELETE FROM pending_messages
        WHERE id = ? AND surface = ? AND chat_key = ? AND state = 'claimed' AND claim_run_id = ? AND claim_acquisition_id = ?
      `).run(id, surface, chatKey, handle.runId, handle.acquisitionId).changes === 1;
    });
  }

  admitMessage(
    surface: string,
    chatKey: string,
    msg: { prompt: string; chatId: number; threadId?: number; chatType: string; userId?: number; attachments?: string[] },
    maxDepth: number,
  ): { kind: "execute_current"; handle: ExecutionLaneHandle } | { kind: "queued"; position: number } | { kind: "full" } |
     { kind: "execute_claimed"; position: number; handle: ExecutionLaneHandle; claimed: ReturnType<BridgeDb["claimNextPendingMsg"]> & {} } {
    assertExecutionScope(surface, chatKey);
    return this.runInTransaction(() => {
      const pending = this.pendingMsgCount(surface, chatKey);
      const directHandle = pending === 0 ? this.locks.acquire(surface, chatKey) : null;
      if (directHandle) return { kind: "execute_current" as const, handle: directHandle };
      if (pending >= maxDepth) return { kind: "full" as const };
      this.enqueueMsg(surface, chatKey, msg);
      const position = pending + 1;
      const queueHandle = this.locks.acquire(surface, chatKey);
      if (queueHandle) {
        const claimed = this.claimNextPendingMsg(queueHandle);
        if (claimed) return { kind: "execute_claimed" as const, position, handle: queueHandle, claimed };
      }
      return { kind: "queued" as const, position };
    });
  }

  releasePendingClaim(handle: ExecutionLaneHandle, id: number): void {
    if (!this.locks.owns(handle)) return;
    this.raw.prepare(`UPDATE pending_messages SET state = 'queued', claim_run_id = NULL, claim_acquisition_id = NULL, claimed_at = NULL WHERE id = ? AND claim_run_id = ? AND claim_acquisition_id = ?`)
      .run(id, handle.runId, handle.acquisitionId);
  }

  unlockIfQueueEmpty(handle: ExecutionLaneHandle): boolean {
    const { surface, chatKey } = handle;
    assertExecutionScope(surface, chatKey);
    return this.runInTransaction(() => {
      if (!this.ownsLock(handle)) return false;
      const pending = this.raw.prepare(`SELECT 1 FROM pending_messages WHERE surface = ? AND chat_key = ? LIMIT 1`).get(surface, chatKey);
      if (pending) return false;
      return this.unlock(handle);
    });
  }

  getQuarantinedPendingMessageCount(): number {
    const { count } = this.raw.prepare(
      `SELECT COUNT(*) AS count FROM pending_messages WHERE surface = 'legacy'`
    ).get() as { count: number };
    return count;
  }

  getPendingLaneKeys(surface: string): string[] {
    if (!surface?.trim()) throw new Error("surface is required");
    return (this.raw.prepare(`SELECT DISTINCT chat_key AS chatKey FROM pending_messages WHERE surface = ? ORDER BY chat_key`)
      .all(surface) as Array<{ chatKey: string }>).map((row) => row.chatKey);
  }

  // ── Conversation summaries ──────────────────────────────────────────────
  addConvSummary(chatKey: string, startTurnId: number, endTurnId: number, summaryMd: string): void {
    this.raw
      .prepare(
        `INSERT INTO conversation_summaries (chat_key, range_start_turn_id, range_end_turn_id, summary_md)
         VALUES (?, ?, ?, ?)`
      )
      .run(chatKey, startTurnId, endTurnId, summaryMd);
  }

  getLatestConvSummary(chatKey: string): {
    id: number; range_start_turn_id: number; range_end_turn_id: number; summary_md: string; created_at: string;
  } | null {
    return (this.raw
      .prepare(
        `SELECT id, range_start_turn_id, range_end_turn_id, summary_md, created_at
         FROM conversation_summaries WHERE chat_key = ? ORDER BY id DESC LIMIT 1`
      )
      .get(chatKey) as any) ?? null;
  }

  getConvTurnsForCompaction(chatKey: string): Array<{ id: number; role: string; text: string; cli: string | null; created_at: string }> {
    const summary = this.getLatestConvSummary(chatKey);
    return this.raw
      .prepare(
        `SELECT id, role, text, cli, created_at FROM conversation_turns
         WHERE chat_key = ? AND id > ?
         ORDER BY id ASC`
      )
      .all(chatKey, summary?.range_end_turn_id ?? 0) as any;
  }

  getUncompactedConvStats(chatKey: string): { turnCount: number; charCount: number } {
    const summary = this.getLatestConvSummary(chatKey);
    return this.raw
      .prepare(
        `SELECT COUNT(*) AS turnCount, COALESCE(SUM(LENGTH(text)), 0) AS charCount
         FROM conversation_turns WHERE chat_key = ? AND id > ?`
      )
      .get(chatKey, summary?.range_end_turn_id ?? 0) as { turnCount: number; charCount: number };
  }

  pruneConvTurns(chatKey: string, upToTurnId: number): void {
    this.raw
      .prepare(`DELETE FROM conversation_turns WHERE chat_key = ? AND id <= ?`)
      .run(chatKey, upToTurnId);
  }

  clearConvHistory(chatKey: string): void {
    this.raw.prepare(`DELETE FROM conversation_turns WHERE chat_key = ?`).run(chatKey);
    this.raw.prepare(`DELETE FROM conversation_summaries WHERE chat_key = ?`).run(chatKey);
  }

  getConvStatus(chatKey: string, surface: string): {
    turnCount: number; pendingCount: number; latestSummaryAt: string | null; latestTurnAt: string | null;
  } {
    assertExecutionScope(surface, chatKey);
    const tc = this.raw
      .prepare(`SELECT COUNT(*) AS n FROM conversation_turns WHERE chat_key = ?`)
      .get(chatKey) as { n: number };
    const pc = this.raw
      .prepare(`SELECT COUNT(*) AS n FROM pending_messages WHERE surface = ? AND chat_key = ?`)
      .get(surface, chatKey) as { n: number };
    const lt = this.raw
      .prepare(`SELECT created_at FROM conversation_turns WHERE chat_key = ? ORDER BY id DESC LIMIT 1`)
      .get(chatKey) as { created_at: string } | undefined;
    const ls = this.raw
      .prepare(`SELECT created_at FROM conversation_summaries WHERE chat_key = ? ORDER BY id DESC LIMIT 1`)
      .get(chatKey) as { created_at: string } | undefined;
    return {
      turnCount: tc.n,
      pendingCount: pc.n,
      latestSummaryAt: ls?.created_at ?? null,
      latestTurnAt: lt?.created_at ?? null,
    };
  }

  addCompactionAttempt(input: CompactionAttemptInput): void {
    this.compactions.addAttempt(input);
  }

  getLatestCompactionAttempt(chatKey: string): CompactionAttemptRecord | null {
    return this.compactions.getLatestAttempt(chatKey);
  }

  // ── Project memory ────────────────────────────────────────────────────────

  addMemory(mem: { id: string; type: string; scope?: string; text: string; source_chat_key?: string; source_cli?: string; source_turn_id?: number; source_repo_path?: string; confidence?: number }): void {
    this.memories.addMemory(mem);
  }

  findMemoryByText(text: string): { id: string } | null {
    return this.memories.findMemoryByText(text);
  }

  getLatestConvTurnId(chatKey: string): number | null {
    return this.memories.getLatestConvTurnId(chatKey);
  }

  searchMemories(query: string, limit = 5, chatKey?: string): Array<{ id: string; type: string; text: string; score: number; snippet: string }> {
    return chatKey === undefined
      ? this.memories.searchMemories(query, limit)
      : this.memories.searchMemories(query, limit, chatKey);
  }

  getMemoryCount(): number {
    return this.memories.getMemoryCount();
  }

  getPrompt(name: string, fallback: string): string {
    const row = this.raw.prepare("SELECT prompt_text FROM prompts WHERE name = ?").get(name) as { prompt_text: string } | undefined;
    return row ? row.prompt_text : fallback;
  }

  setPrompt(name: string, promptText: string): void {
    this.raw.prepare(
      `INSERT INTO prompts (name, prompt_text)
       VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET
         prompt_text = excluded.prompt_text,
         updated_at = CURRENT_TIMESTAMP`
    ).run(name, promptText);
  }

  close(): void {
    this.raw.close();
  }
}

// ── Domain types ─────────────────────────────────────────────────────────────

export interface WorkItem {
  id: number;
  kind: string;
  source: string;
  repository: string | null;
  title: string;
  body: string | null;
  status: string;
  priority: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WorkJob {
  id: number;
  work_item_id: number | null;
  task_type: string;
  status: string;
  bot: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  attempt_count: number;
  max_attempts: number;
  idempotency_key: string;
  input_json: string;
  result_json: string | null;
  error: string | null;
  phase: string;
  phase_data_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface Approval {
  id: number;
  work_item_id: number | null;
  job_id: number | null;
  approval_type: string;
  status: string;
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string | null;
  payload_json: string;
}

export interface GithubLink {
  id: number;
  work_item_id: number;
  repository: string;
  issue_number: number | null;
  pr_number: number | null;
  branch_name: string | null;
  commit_sha: string | null;
  remote_url: string | null;
  pr_state: string;
  last_activity_at: string | null;
  proof_comment_sha: string | null;
  created_at: string;
  updated_at: string;
}

export interface FeaturePlan {
  id: number;
  chat_id: string;
  user_id: string;
  status: string;
  brief: string;
  scope_json: string;
  created_at: string;
  updated_at: string;
}

export interface WorkItemPlan {
  id: number;
  work_item_id: number;
  plan_text: string;
  quality_json: string;
  created_at: string;
  updated_at: string;
}
