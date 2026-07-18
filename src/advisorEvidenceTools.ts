import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { redactAdvisorText } from "./advisorPrompt.js";

export type AdvisorEvidenceToolName =
  | "repo.list_files"
  | "repo.read_file"
  | "repo.search_text"
  | "git.status"
  | "git.diff"
  | "git.show"
  | "git.log"
  | "evidence.acceptance"
  | "evidence.plan"
  | "evidence.test_failures"
  | "evidence.attempt_summary";

export type AdvisorEvidenceToolRequest =
  | { tool: "repo.list_files"; path?: string; depth?: number }
  | { tool: "repo.read_file"; path: string }
  | { tool: "repo.search_text"; query: string; path?: string }
  | { tool: "git.status" }
  | { tool: "git.diff"; scope?: "working" | "staged" | "base_to_head"; base?: string; head?: string }
  | { tool: "git.show"; object: string; path?: string }
  | { tool: "git.log"; count?: number }
  | { tool: "evidence.acceptance" }
  | { tool: "evidence.plan" }
  | { tool: "evidence.test_failures" }
  | { tool: "evidence.attempt_summary" };

export interface AdvisorEvidenceToolResult {
  evidenceId: string;
  tool: AdvisorEvidenceToolName;
  status: "ok" | "denied" | "failed" | "unavailable" | "exhausted";
  summary: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface AdvisorEvidenceAuditEvent {
  tool: AdvisorEvidenceToolName;
  status: AdvisorEvidenceToolResult["status"];
  evidenceId: string;
  durationMs: number;
  bytes: number;
  truncated: boolean;
  arguments: Record<string, string | number | boolean>;
}

export interface AdvisorEvidenceToolLimits {
  maxCalls: number;
  maxResultBytes: number;
  maxAggregateBytes: number;
  maxFiles: number;
  maxMatches: number;
  maxDepth: number;
  timeoutMs: number;
}

export interface AdvisorWorkerEvidence {
  acceptance?: string;
  plan?: string;
  testFailures?: string;
  attemptSummary?: string;
}

type RunGit = (args: string[], cwd: string) => string | Promise<string>;

const DEFAULT_LIMITS: AdvisorEvidenceToolLimits = {
  maxCalls: 6,
  maxResultBytes: 8_000,
  maxAggregateBytes: 30_000,
  maxFiles: 120,
  maxMatches: 60,
  maxDepth: 5,
  timeoutMs: 5_000,
};

const SENSITIVE_BASENAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "known_hosts",
]);

const GIT_READ_PREFIX = [
  "--no-pager",
  "-c", "core.fsmonitor=false",
  "-c", "credential.helper=",
];

function hasSensitivePath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean).map((part) => part.toLowerCase());
  const base = parts.at(-1) ?? "";
  if (parts.includes(".git")) return true;
  if (base.startsWith(".env")) return true;
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (/\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(base)) return true;
  if (parts.includes(".ssh") || parts.includes("workspace-secrets") || parts.includes("secrets")) return true;
  return /(?:^|[._-])(?:token|secret|credential)(?:s)?(?:[._-]|$)/i.test(base);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function safeRelativePath(value: unknown, field: string, optional = false): string {
  if (value == null && optional) return ".";
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty relative path`);
  if (value.includes("\0") || isAbsolute(value)) throw new Error(`${field} must stay inside the worktree`);
  const normalized = normalize(value).replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${field} escapes the worktree`);
  }
  if (hasSensitivePath(normalized)) throw new Error(`${field} targets a sensitive path`);
  return normalized === "" ? "." : normalized;
}

function safeGitRef(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value)) {
    throw new Error(`${field} is not a supported Git object`);
  }
  if (value.startsWith("-") || value.includes("..") || value.includes("@{") || value.endsWith("/")) {
    throw new Error(`${field} is not a supported Git object`);
  }
  return value;
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let text = bytes.subarray(0, Math.max(0, maxBytes)).toString("utf8");
  while (text.endsWith("�")) text = text.slice(0, -1);
  return { text, truncated: true };
}

export function parseAdvisorEvidenceToolRequest(value: unknown): AdvisorEvidenceToolRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Advisor tool request must be an object");
  const input = value as Record<string, unknown>;
  switch (input.tool) {
    case "repo.list_files":
      return {
        tool: "repo.list_files",
        path: safeRelativePath(input.path, "path", true),
        depth: boundedInteger(input.depth, 3, 0, 8),
      };
    case "repo.read_file":
      return { tool: "repo.read_file", path: safeRelativePath(input.path, "path") };
    case "repo.search_text": {
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 200) {
        throw new Error("query must be a non-empty literal of at most 200 characters");
      }
      return { tool: "repo.search_text", query: input.query, path: safeRelativePath(input.path, "path", true) };
    }
    case "git.status":
      return { tool: "git.status" };
    case "git.diff": {
      const scope = input.scope == null ? "working" : input.scope;
      if (!(["working", "staged", "base_to_head"] as unknown[]).includes(scope)) throw new Error("Unsupported git.diff scope");
      if (scope === "base_to_head") {
        return { tool: "git.diff", scope, base: safeGitRef(input.base, "base"), head: safeGitRef(input.head, "head") };
      }
      return { tool: "git.diff", scope: scope as "working" | "staged" };
    }
    case "git.show": {
      const path = input.path == null ? undefined : safeRelativePath(input.path, "path");
      if (path?.includes(":")) throw new Error("path is not supported for git.show");
      return {
        tool: "git.show",
        object: safeGitRef(input.object, "object"),
        ...(path == null ? {} : { path }),
      };
    }
    case "git.log":
      return { tool: "git.log", count: boundedInteger(input.count, 10, 1, 20) };
    case "evidence.acceptance":
    case "evidence.plan":
    case "evidence.test_failures":
    case "evidence.attempt_summary":
      return { tool: input.tool };
    default:
      throw new Error("Unsupported advisor evidence tool");
  }
}

export class AdvisorEvidenceToolBroker {
  private readonly root: string;
  private readonly limits: AdvisorEvidenceToolLimits;
  private calls = 0;
  private aggregateBytes = 0;

  constructor(private readonly options: {
    repoPath: string;
    runGit?: RunGit;
    evidence?: AdvisorWorkerEvidence;
    limits?: Partial<AdvisorEvidenceToolLimits>;
    audit?: (event: AdvisorEvidenceAuditEvent) => void;
  }) {
    this.root = realpathSync(options.repoPath);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  async execute(requests: AdvisorEvidenceToolRequest[]): Promise<AdvisorEvidenceToolResult[]> {
    if (requests.length > this.limits.maxCalls) throw new Error(`Advisor evidence tool limit exceeded: ${requests.length}/${this.limits.maxCalls}`);
    const results: AdvisorEvidenceToolResult[] = [];
    for (const request of requests) results.push(await this.executeOne(request));
    return results;
  }

  private async executeOne(request: AdvisorEvidenceToolRequest): Promise<AdvisorEvidenceToolResult> {
    const startedAt = Date.now();
    this.calls += 1;
    if (this.calls > this.limits.maxCalls) return this.result(request, "exhausted", "Tool-call budget exhausted", "", startedAt);
    try {
      const content = await this.withTimeout(this.perform(request));
      return this.result(request, "ok", "Read-only evidence collected", content, startedAt);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const denied = /escape|sensitive|symlink|binary|must stay inside|relative path|unsupported git object|not supported for git\.show/i.test(error.message);
      const unavailable = /unavailable/i.test(error.message);
      return this.result(request, denied ? "denied" : unavailable ? "unavailable" : "failed", redactAdvisorText(error.message), "", startedAt);
    }
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Advisor evidence tool timeout")), this.limits.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private result(
    request: AdvisorEvidenceToolRequest,
    status: AdvisorEvidenceToolResult["status"],
    summary: string,
    rawContent: string,
    startedAt: number,
  ): AdvisorEvidenceToolResult {
    const remaining = Math.max(0, this.limits.maxAggregateBytes - this.aggregateBytes);
    const maxBytes = Math.min(this.limits.maxResultBytes, remaining);
    const bounded = truncateUtf8(redactAdvisorText(rawContent), maxBytes);
    const content = maxBytes > 0 ? bounded.text : "";
    const bytes = Buffer.byteLength(content, "utf8");
    this.aggregateBytes += bytes;
    const exhausted = remaining === 0 && status === "ok";
    const finalStatus = exhausted ? "exhausted" : status;
    const truncated = bounded.truncated || exhausted;
    const evidenceId = `ev_${createHash("sha256")
      .update(JSON.stringify({ tool: request.tool, request: this.auditArguments(request), status: finalStatus, truncated, contentHash: createHash("sha256").update(content).digest("hex") }))
      .digest("hex")
      .slice(0, 16)}`;
    const result: AdvisorEvidenceToolResult = {
      evidenceId,
      tool: request.tool,
      status: finalStatus,
      summary: exhausted
        ? "Aggregate evidence byte budget exhausted"
        : `${summary.slice(0, 450)}${truncated ? " (truncated by evidence byte budget)" : ""}`,
      content,
      bytes,
      truncated,
    };
    this.options.audit?.({
      tool: request.tool,
      status: result.status,
      evidenceId,
      durationMs: Date.now() - startedAt,
      bytes,
      truncated,
      arguments: this.auditArguments(request),
    });
    return result;
  }

  private auditArguments(request: AdvisorEvidenceToolRequest): Record<string, string | number | boolean> {
    switch (request.tool) {
      case "repo.list_files": return { path: request.path ?? ".", depth: request.depth ?? 3 };
      case "repo.read_file": return { path: request.path };
      case "repo.search_text": return { path: request.path ?? ".", queryChars: request.query.length };
      case "git.diff": return { scope: request.scope ?? "working", hasBase: Boolean(request.base), hasHead: Boolean(request.head) };
      case "git.show": return { object: request.object, hasPath: Boolean(request.path) };
      case "git.log": return { count: request.count ?? 10 };
      default: return {};
    }
  }

  private gitArgs(args: string[]): string[] {
    return [...GIT_READ_PREFIX, ...args];
  }

  private async perform(request: AdvisorEvidenceToolRequest): Promise<string> {
    switch (request.tool) {
      case "repo.list_files":
        return this.listFiles(request.path ?? ".", request.depth ?? 3).join("\n");
      case "repo.read_file":
        return this.readText(request.path);
      case "repo.search_text":
        return this.searchText(request.path ?? ".", request.query);
      case "git.status":
        return this.runGit(this.gitArgs(["status", "--short", "--branch", "--untracked-files=normal"]));
      case "git.diff":
        if (request.scope === "staged") return this.runGit(this.gitArgs(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=3"]));
        if (request.scope === "base_to_head") return this.runGit(this.gitArgs(["diff", "--no-ext-diff", "--no-textconv", "--unified=3", `${request.base}...${request.head}`]));
        return this.runGit(this.gitArgs(["diff", "--no-ext-diff", "--no-textconv", "--unified=3"]));
      case "git.show":
        return request.path
          ? this.runGit(this.gitArgs(["show", "--no-ext-diff", "--no-textconv", `${request.object}:${request.path}`]))
          : this.runGit(this.gitArgs(["show", "--no-patch", "--format=medium", "--stat", request.object]));
      case "git.log":
        return this.runGit(this.gitArgs(["log", `-${request.count ?? 10}`, "--date=iso-strict", "--pretty=format:%H%x09%ad%x09%s"]));
      case "evidence.acceptance":
        return this.workerEvidence("acceptance");
      case "evidence.plan":
        return this.workerEvidence("plan");
      case "evidence.test_failures":
        return this.workerEvidence("testFailures");
      case "evidence.attempt_summary":
        return this.workerEvidence("attemptSummary");
    }
  }

  private workerEvidence(key: keyof AdvisorWorkerEvidence): string {
    const value = this.options.evidence?.[key];
    if (!value) throw new Error(`Advisor evidence unavailable: ${key}`);
    return value;
  }

  private async runGit(args: string[]): Promise<string> {
    if (!this.options.runGit) throw new Error("Advisor Git evidence unavailable");
    return String(await this.options.runGit(args, this.root));
  }

  private resolveExisting(relativePath: string): string {
    const normalizedPath = safeRelativePath(relativePath, "path", true);
    const candidate = resolve(this.root, normalizedPath);
    const rel = relative(this.root, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path escapes the worktree");

    let current = this.root;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = resolve(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error("Symlink paths are denied for advisor evidence");
    }
    const canonical = realpathSync(candidate);
    const canonicalRel = relative(this.root, canonical);
    if (canonicalRel === ".." || canonicalRel.startsWith(`..${sep}`) || isAbsolute(canonicalRel)) throw new Error("Resolved path escapes the worktree");
    return canonical;
  }

  private readText(relativePath: string): string {
    const path = this.resolveExisting(relativePath);
    if (!statSync(path).isFile()) throw new Error("Advisor evidence path is not a file");
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(this.limits.maxResultBytes + 1);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      const content = buffer.subarray(0, bytes);
      if (content.includes(0)) throw new Error("Binary files are denied for advisor evidence");
      const text = content.toString("utf8");
      if (text.includes("�")) throw new Error("Binary or invalid UTF-8 files are denied for advisor evidence");
      return text;
    } finally {
      closeSync(fd);
    }
  }

  private listFiles(relativePath: string, requestedDepth: number): string[] {
    const base = this.resolveExisting(relativePath);
    if (!statSync(base).isDirectory()) throw new Error("Advisor evidence path is not a directory");
    const maxDepth = Math.min(requestedDepth, this.limits.maxDepth);
    const files: string[] = [];
    const visit = (dir: string, depth: number): void => {
      if (files.length >= this.limits.maxFiles || depth > maxDepth) return;
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= this.limits.maxFiles) break;
        const absolute = resolve(dir, entry.name);
        const rel = relative(this.root, absolute).replaceAll("\\", "/");
        if (entry.isSymbolicLink() || hasSensitivePath(rel)) continue;
        if (entry.isDirectory()) visit(absolute, depth + 1);
        else if (entry.isFile()) files.push(rel);
      }
    };
    visit(base, 0);
    return files;
  }

  private searchText(relativePath: string, query: string): string {
    const files = this.listFiles(relativePath, this.limits.maxDepth);
    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= this.limits.maxMatches) break;
      let text: string;
      try { text = this.readText(file); } catch { continue; }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && matches.length < this.limits.maxMatches; index++) {
        if (lines[index].includes(query)) matches.push(`${file}:${index + 1}: ${lines[index].slice(0, 500)}`);
      }
    }
    return matches.length ? matches.join("\n") : "No literal matches found.";
  }
}
