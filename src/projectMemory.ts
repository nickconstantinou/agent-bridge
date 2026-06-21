/**
 * PURPOSE: Validate, extract, and store bridge-owned project memory candidates.
 * INPUTS: Candidate JSON from agent helpers or post-turn sidecars.
 * OUTPUTS: Stored project_memories rows plus cleaned assistant text.
 * NEIGHBORS: src/contextCommand.ts, src/engine.ts, src/db.ts
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { cwd } from "node:process";

export type ProjectMemoryCandidate = {
  type?: unknown;
  scope?: unknown;
  text?: unknown;
  confidence?: unknown;
};

export type ProjectMemoryProvenance = {
  chatKey: string;
  cliKind?: string | null;
  repoPath?: string | null;
};

export type ProjectMemoryStoreResult =
  | { status: "stored"; id: string }
  | { status: "duplicate"; id: string }
  | { status: "rejected"; reason: string };

const ALLOWED_MEMORY_TYPES = new Set(["decision", "bug", "bugfix", "bug_fix", "convention", "todo", "note"]);
const ALLOWED_MEMORY_SCOPES = new Set(["project", "chat", "global"]);

function normalizeMemoryText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function looksSecretLike(text: string): boolean {
  return [
    /\b(?:api[_-]?key|token|password|secret|private[_-]?key)\b\s*[:=]/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:sk|pk|ghp|gho|github_pat|xoxb|xoxp)-[a-z0-9_\-]{16,}\b/i,
    /\b[A-Za-z0-9_/\-+=]{40,}\b/,
  ].some((re) => re.test(text));
}

function looksTransient(text: string): boolean {
  return /\b(?:for now|temporary|temporarily|today only|just tried|current run)\b/i.test(text);
}

function memoryId(type: string, scope: string, text: string): string {
  const digest = createHash("sha256").update(`${type}\0${scope}\0${normalizeMemoryText(text)}`).digest("hex").slice(0, 16);
  return `mem_bridge_${digest}`;
}

export function storeProjectMemoryCandidate(
  db: Database.Database,
  rawCandidate: ProjectMemoryCandidate,
  provenance: ProjectMemoryProvenance,
): ProjectMemoryStoreResult {
  const type = typeof rawCandidate.type === "string" ? rawCandidate.type.trim() : "decision";
  const scope = typeof rawCandidate.scope === "string" ? rawCandidate.scope.trim() : "project";
  const text = typeof rawCandidate.text === "string" ? rawCandidate.text.replace(/\s+/g, " ").trim() : "";
  const confidence = typeof rawCandidate.confidence === "number" && Number.isFinite(rawCandidate.confidence)
    ? Math.max(0, Math.min(1, rawCandidate.confidence))
    : 1;

  if (!ALLOWED_MEMORY_TYPES.has(type)) return { status: "rejected", reason: `invalid type '${type}'` };
  if (!ALLOWED_MEMORY_SCOPES.has(scope)) return { status: "rejected", reason: `invalid scope '${scope}'` };
  if (text.length < 12) return { status: "rejected", reason: "text is too short" };
  if (text.length > 2_000) return { status: "rejected", reason: "text is too long" };
  if (looksSecretLike(text)) return { status: "rejected", reason: "secret-looking text" };
  if (looksTransient(text)) return { status: "rejected", reason: "transient text" };

  const duplicate = db.prepare(
    `SELECT id FROM project_memories WHERE lower(text) = lower(?) LIMIT 1`,
  ).get(text) as { id: string } | undefined;
  if (duplicate) return { status: "duplicate", id: duplicate.id };

  const latestTurn = db.prepare(
    `SELECT id FROM conversation_turns WHERE chat_key = ? ORDER BY id DESC LIMIT 1`,
  ).get(provenance.chatKey) as { id: number } | undefined;
  const id = memoryId(type, scope, text);
  db.prepare(`
    INSERT INTO project_memories (
      id, type, scope, text, source_chat_key, source_cli, source_turn_id, source_repo_path, confidence
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    type,
    scope,
    text,
    provenance.chatKey,
    provenance.cliKind?.trim() || null,
    latestTurn?.id ?? null,
    provenance.repoPath?.trim() || cwd(),
    confidence,
  );
  return { status: "stored", id };
}

export function storeProjectMemoryCandidateJson(
  db: Database.Database,
  rawJson: string,
  provenance: ProjectMemoryProvenance,
): ProjectMemoryStoreResult {
  try {
    return storeProjectMemoryCandidate(db, JSON.parse(rawJson) as ProjectMemoryCandidate, provenance);
  } catch {
    return { status: "rejected", reason: "invalid JSON" };
  }
}

export function formatProjectMemoryStoreResult(result: ProjectMemoryStoreResult): string {
  if (result.status === "stored") return `Memory stored: ${result.id}`;
  if (result.status === "duplicate") return `Memory duplicate: ${result.id}`;
  return `Memory rejected: ${result.reason}.`;
}

export function extractProjectMemorySidecars(text: string): {
  cleanText: string;
  candidates: ProjectMemoryCandidate[];
} {
  const candidates: ProjectMemoryCandidate[] = [];
  const cleanText = text
    .replace(/<!--\s*agent-bridge-memory\s*([\s\S]*?)\s*-->/gi, (_match, json) => {
      collectCandidates(json, candidates);
      return "";
    })
    .replace(/<agent-bridge-memory>\s*([\s\S]*?)\s*<\/agent-bridge-memory>/gi, (_match, json) => {
      collectCandidates(json, candidates);
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanText, candidates };
}

function collectCandidates(rawJson: string, out: ProjectMemoryCandidate[]): void {
  try {
    const parsed = JSON.parse(rawJson);
    if (Array.isArray(parsed)) {
      out.push(...parsed.filter((item) => item && typeof item === "object") as ProjectMemoryCandidate[]);
    } else if (parsed && typeof parsed === "object") {
      out.push(parsed as ProjectMemoryCandidate);
    }
  } catch {
    // Invalid sidecars are stripped but not stored.
  }
}
