/**
 * PURPOSE: Child process management, CLI invocation builder, and execution response parsers for different bot CLI kinds.
 * INPUTS: Prompts, session IDs, model types, execution modes, and raw stdout/log file contents.
 * OUTPUTS: Spawned subprocess lifecycles, structured CLI command definitions, and parsed agent text responses and session IDs.
 * NEIGHBORS: src/index.ts, src/timeouts.ts
 * LOGIC: Spawns platform-specific CLI shells, applies strict timeouts, processes stdout streams with regex to isolate message content, and parses logs for session IDs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliOptions, CliResult, BotKind } from "./types.js";
import { resolveTimeoutsForKind } from "./timeouts.js";

const activeProcesses = new Map<number | string, ChildProcess>();
const abortedChildren = new WeakSet<ChildProcess>();

const KILL_GRACE_MS = 5_000;

function killWithGrace(child: ChildProcess, graceMs: number = KILL_GRACE_MS): void {
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, graceMs);
  child.once("close", () => clearTimeout(t));
}

function killChild(child: ChildProcess): void {
  abortedChildren.add(child);
  killWithGrace(child);
}

function killProcessTree(child: ChildProcess, pid: number, graceMs: number = KILL_GRACE_MS): void {
  try { process.kill(-pid, "SIGTERM"); } catch { /* ignore — process may have already exited */ }
  const t = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ } }, graceMs);
  child.once("close", () => clearTimeout(t));
}

export function abortCliProcess(chatId: number | string): boolean {
  const child = activeProcesses.get(chatId);
  if (!child) return false;
  killChild(child);
  activeProcesses.delete(chatId);
  return true;
}

export function shutdownCliProcesses(): number {
  const children = [...activeProcesses.values()];
  for (const child of children) {
    killChild(child);
  }
  const count = children.length;
  activeProcesses.clear();
  return count;
}

/**
 * Builds the CLI invocation for a bot.
 */
export function buildCliInvocation({
  bot,
  prompt,
  sessionId,
  sessionMode = "resume",
  command,
  model,
  executionMode = "safe",
  outputFormat = null,
  logFile = null,
}: {
  bot: string;
  prompt: string;
  sessionId: string | null;
  sessionMode?: "resume" | "session-id";
  command: string;
  model: string | null;
  executionMode?: "safe" | "trusted";
  outputFormat?: "json" | null;
  logFile?: string | null;
}): { command: string; args: string[] } {
  const args = [];

  if (bot === "codex") {
    if (sessionId) {
      args.push("exec", "resume", sessionId);
    } else {
      args.push("exec");
    }
    args.push("--skip-git-repo-check");
    if (model) {
      args.push("--model", model);
    }
    if (executionMode === "trusted") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    if (outputFormat === "json") {
      args.push("--json");
    }
    args.push(prompt);
  } else if (bot === "claude") {
    args.push("--print");
    if (model) args.push("--model", model);
    if (sessionId) args.push("--resume", sessionId);
    if (executionMode === "trusted") args.push("--dangerously-skip-permissions");
    if (outputFormat === "json") args.push("--output-format", "json");
    args.push(prompt);
  } else if (bot === "antigravity") {
    // Agy's --print flag takes the prompt as its value, so all other flags must come first.
    // Current Agy builds do not expose a working --model CLI flag; model selection is managed by Agy itself.
    if (sessionId) args.push("--conversation", sessionId);
    if (executionMode === "trusted") args.push("--dangerously-skip-permissions");
    if (logFile) args.push("--log-file", logFile);
    args.push("--print", prompt);
  }

  return { command, args };
}

/**
 * Validates the bridge configuration.
 */
export function validateBridgeConfig(config: any): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.allowedUserIds?.size) {
    errors.push("TELEGRAM_ALLOWED_USER_IDS is required");
  }

  // Skip bot validation - each service validates its own bot in index.ts
  // This allows antigravity service to run without codex token and vice versa

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * Resolve CLI execution options for a specific bot kind.
 * Reads env vars at call time so tests can stub them.
 */
export function buildExecutionOptions(kind: BotKind): CliOptions {
  const t = resolveTimeoutsForKind(kind);
  return {
    timeoutMs: t.cliTimeoutMs,
    idleTimeoutMs: t.cliIdleTimeoutMs,
  };
}

/**
 * Parses the CLI result.
 */
export function parseCliResult({
  bot,
  stdout,
  logContent = null,
}: {
  bot: string;
  stdout: string;
  logContent?: string | null;
}): CliResult {
  if (bot === "codex") {
    return parseCodexResult(stdout);
  } else if (bot === "claude") {
    return parseClaudeResult(stdout);
  } else if (bot === "antigravity") {
    return parseAntigravityResult(stdout, logContent);
  }
  throw new Error(`Unknown bot type: ${bot}`);
}

function parseCodexResult(stdout: string): CliResult {
  let sessionId: string | null = null;
  let finalText: string | null = null;
  const deltaChunks: string[] = [];

  const lines = stdout.split("\n").map((v) => v.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "thread.started" && e.thread_id) {
        sessionId = e.thread_id;
      } else if (
        (e.type === "item.completed" || e.type === "item.updated") &&
        e.item?.type === "agent_message" &&
        typeof e.item.text === "string"
      ) {
        finalText = e.item.text;
      } else if (e.type === "response.completed" && typeof e.output_text === "string") {
        finalText = e.output_text;
      } else if (e.type === "response.output_text.delta" && e.delta) {
        deltaChunks.push(e.delta);
      }
    } catch {
      // not JSON, skip
    }
  }

  return {
    text: (finalText ?? deltaChunks.join("")).trim(),
    sessionId,
  };
}


function parseClaudeResult(stdout: string): CliResult {
  const lines = stdout.split("\n").map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.result != null) {
        return { text: String(obj.result).trim(), sessionId: obj.session_id ?? null };
      }
    } catch { /* not JSON */ }
  }
  return { text: stdout.trim(), sessionId: null };
}

export function extractAntigravityConversationId(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/Created conversation ([a-f0-9-]{36})/) ||
    text.match(/Print mode: conversation=([a-f0-9-]{36})/) ||
    text.match(/conversation=([a-f0-9-]{36})/);
  return match?.[1] ?? null;
}

export function readAntigravityLastConversation({
  cwd,
  homeDir = homedir(),
}: {
  cwd: string;
  homeDir?: string;
}): string | null {
  const cachePath = join(homeDir, ".gemini", "antigravity-cli", "cache", "last_conversations.json");
  if (!existsSync(cachePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    const value = parsed[cwd];
    return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function readLatestAntigravityConversationFromLogs({
  sinceMs,
  homeDir = homedir(),
}: {
  sinceMs: number;
  homeDir?: string;
}): string | null {
  const logDir = join(homeDir, ".gemini", "antigravity-cli", "log");
  if (!existsSync(logDir)) return null;

  try {
    const logFiles = readdirSync(logDir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => {
        const path = join(logDir, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .filter((file) => file.mtimeMs >= sinceMs - 1000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of logFiles) {
      const sessionId = extractAntigravityConversationId(readFileSync(file.path, "utf8"));
      if (sessionId) return sessionId;
    }
  } catch {
    return null;
  }

  return null;
}

export function resolveAntigravityConversationId({
  cwd,
  sinceMs,
  explicitLogContent,
  homeDir = homedir(),
}: {
  cwd: string;
  sinceMs: number;
  explicitLogContent?: string | null;
  homeDir?: string;
}): string | null {
  return extractAntigravityConversationId(explicitLogContent) ??
    readLatestAntigravityConversationFromLogs({ sinceMs, homeDir }) ??
    readAntigravityLastConversation({ cwd, homeDir });
}

function parseAntigravityResult(stdout: string, logContent?: string | null): CliResult {
  return { text: stdout.trim(), sessionId: extractAntigravityConversationId(logContent) };
}

export function toUserMessage(err: Error): string {
  return err.message.split(":")[0].trim();
}

export function isCapacityExhaustedError(err: Error): boolean {
  const msg = err.message || "";
  return (
    msg.includes("MODEL_CAPACITY_EXHAUSTED") ||
    msg.includes("No capacity available") ||
    msg.includes("rateLimitExceeded") ||
    msg.includes("overloaded_error") ||
    msg.includes("Overloaded")
  );
}

export function getNextFallbackModel(currentModel: string | null, modelPreference: string[]): string | null {
  if (!currentModel || modelPreference.length <= 1) return null;
  const idx = modelPreference.indexOf(currentModel);
  if (idx === -1 || idx >= modelPreference.length - 1) return null;
  return modelPreference[idx + 1];
}

function formatSpawnLog(command: string, args: string[], cwd: string, chatId?: number | string): string {
  const visibleArgs = args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ");
  const chatPart = chatId != null ? ` chatId=${String(chatId)}` : "";
  return `[spawn]${chatPart} cwd=${cwd} command=${command} args=${visibleArgs}`;
}

/**
 * Runs a CLI command and returns stdout.
 */
export async function runCli(command: string, args: string[], cwd: string, options: CliOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? null;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

  return new Promise((resolve, reject) => {
    console.log(formatSpawnLog(command, args, cwd, options.chatId));
    const child = spawn(command, args, { cwd, shell: false });
    child.stdin?.end();
    if (options.chatId != null) activeProcesses.set(options.chatId, child);
    let stdout = "";
    let stderr = "";
    let settled = false;

    const doReject = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const doResolve = (val: string) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const timer = setTimeout(() => {
      console.error(`[HARD TIMEOUT] CLI hard timeout after ${timeoutMs}ms - killing process\n${formatSpawnLog(command, args, cwd, options.chatId)}`);
      doReject(new Error(`CLI hard timeout after ${timeoutMs}ms`));
      killWithGrace(child, killGraceMs);
    }, timeoutMs);

    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimeoutMs === null) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.error(`[IDLE TIMEOUT] CLI idle timeout after ${idleTimeoutMs}ms with no stdout/stderr${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""}`);
        doReject(new Error(`CLI idle timeout after ${idleTimeoutMs}ms`));
        killWithGrace(child, killGraceMs);
      }, idleTimeoutMs);
    };

    resetIdleTimer();

    child.stdout.on("data", (data) => {
      stdout += data;
      resetIdleTimer();
    });

    child.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      console.error(`[stderr]${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${child.pid ?? "?"} ${chunk.trimEnd()}`);
      resetIdleTimer();
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (options.chatId != null) activeProcesses.delete(options.chatId);
      console.log(`[close]${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${child.pid ?? "?"} code=${code} signal=${signal ?? "none"}`);

      if (settled) return;

      if (signal && abortedChildren.has(child)) {
        doResolve(stdout);
      } else if (signal) {
        doReject(new Error(`CLI killed by signal ${signal}: ${stderr || stdout}`));
      } else if (code !== 0 && code !== null) {
        doReject(new Error(`CLI exited with code ${code}: ${stderr || stdout}`));
      } else {
        doResolve(stdout);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (options.chatId != null) activeProcesses.delete(options.chatId);
      doReject(err);
    });
  });
}

/**
 * Runs a CLI command asynchronously with progress support.
 * Uses detached:true so process.kill(-pid) kills the whole subprocess tree.
 */
export async function runCliAsync(
  command: string,
  args: string[],
  cwd: string,
  options: CliOptions = {}
): Promise<{ text: string }> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? null;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const onProgress = options.onProgress;

  return new Promise((resolve, reject) => {
    console.log(formatSpawnLog(command, args, cwd, options.chatId));
    const child = spawn(command, args, { cwd, shell: false, detached: true });
    child.stdin?.end();
    if (options.chatId != null) activeProcesses.set(options.chatId, child);
    const pid = child.pid;
    let settled = false;

    const doReject = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const doResolve = (val: { text: string }) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      console.error(`[HARD TIMEOUT] CLI hard timeout after ${timeoutMs}ms${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"}`);
      if (pid) killProcessTree(child, pid, killGraceMs);
      doReject(new Error(`CLI hard timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimeoutMs === null) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.error(`[IDLE TIMEOUT] CLI idle timeout after ${idleTimeoutMs}ms with no stdout/stderr${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"}`);
        if (pid) killProcessTree(child, pid, killGraceMs);
        doReject(new Error(`CLI idle timeout after ${idleTimeoutMs}ms`));
      }, idleTimeoutMs);
    };
    resetIdleTimer();

    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      resetIdleTimer();
      if (onProgress) onProgress(chunk);
    });

    child.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      console.error(`[stderr]${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"} ${chunk.trimEnd()}`);
      resetIdleTimer();
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (options.chatId != null) activeProcesses.delete(options.chatId);
      console.log(`[close]${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"} code=${code} signal=${signal ?? "none"}`);
      if (settled) return;

      if (signal && abortedChildren.has(child)) {
        doResolve({ text: stdout });
      } else if (signal) {
        doReject(new Error(`CLI killed by signal ${signal}: ${stderr || stdout.slice(-2000)}`));
      } else if (code !== 0 && code !== null) {
        doReject(new Error(`CLI exited with code ${code}: ${stderr || stdout.slice(-2000)}`));
      } else {
        doResolve({ text: stdout });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (options.chatId != null) activeProcesses.delete(options.chatId);
      doReject(err);
    });
  });
}
