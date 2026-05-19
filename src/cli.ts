import { spawn, type ChildProcess } from "node:child_process";
import type { CliOptions, CliResult, BridgeConfig } from "./types.js";

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
}: {
  bot: string;
  prompt: string;
  sessionId: string | null;
  sessionMode?: "resume" | "session-id";
  command: string;
  model: string | null;
  executionMode?: "safe" | "trusted";
  outputFormat?: "json" | null;
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
  } else if (bot === "gemini") {
    if (model) {
      args.push("--model", model);
    }
    if (sessionId) {
      if (sessionMode === "session-id") {
        args.push("--session-id", sessionId);
      } else {
        args.push("--resume", sessionId);
      }
    }
    if (executionMode === "trusted") {
      args.push("--yolo");
    }
    args.push("--prompt", prompt);
  } else if (bot === "claude") {
    args.push("--print");
    if (model) args.push("--model", model);
    if (sessionId) args.push("--resume", sessionId);
    if (executionMode === "trusted") args.push("--dangerously-skip-permissions");
    if (outputFormat === "json") args.push("--output-format", "json");
    args.push(prompt);
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
  // This allows gemini service to run without codex token and vice versa

  return {
    ok: errors.length === 0,
    errors,
  };
}

/**
 * Parses the execution options from a bridge config.
 */
export function buildExecutionOptions(config: BridgeConfig): CliOptions {
  return {
    timeoutMs: config.cliTimeoutMs,
    idleTimeoutMs: config.cliIdleTimeoutMs,
  };
}

/**
 * Parses the CLI result.
 */
export function parseCliResult({ bot, stdout }: { bot: string; stdout: string }): CliResult {
  if (bot === "codex") {
    return parseCodexResult(stdout);
  } else if (bot === "gemini") {
    // If output was JSON, use specific parser
    if (stdout.trim().startsWith("{")) {
      try {
        return parseGeminiStreamJson(stdout);
      } catch {
        // fallthrough to text parser
      }
    }
    return parseGeminiResult(stdout);
  } else if (bot === "claude") {
    return parseClaudeResult(stdout);
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

function parseGeminiResult(stdout: string): CliResult {
  let sessionId: string | null = null;
  let text = "";

  // The Gemini CLI output can be messy. 
  // We look for a JSON block or treat everything as text.
  const cleaned = stdout.replace(/\x1B\[[0-9;]*[mK]/g, ""); // strip ansi

  // Check for the [session:...] marker if not in JSON mode
  const sessionMatch = cleaned.match(/\[session:([^\]]+)\]/);
  if (sessionMatch) {
    sessionId = sessionMatch[1];
  }

  const lines = cleaned.split("\n").filter(l => {
    if (l.includes("[session:")) return false;
    return true;
  });

  text = lines.join("\n").trim();

  return { text, sessionId };
}

function parseGeminiStreamJson(stdout: string): CliResult {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  let text = "";
  let sessionId: string | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      // Handle the specialized stream format from Gemini CLI
      if (parsed.chunk) {
        text += parsed.chunk;
      }
      if (parsed.sessionId) {
        sessionId = parsed.sessionId;
      }
      // If it's a full result object
      if (parsed.text && !parsed.chunk) {
        text = parsed.text;
      }
    } catch {
      // ignore
    }
  }

  return { text: text.trim(), sessionId };
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
      console.error(`[TIMEOUT] CLI hard timeout after ${timeoutMs}ms - killing process\n${formatSpawnLog(command, args, cwd, options.chatId)}`);
      doReject(new Error(`CLI hard timeout after ${timeoutMs}ms`));
      killWithGrace(child, killGraceMs);
    }, timeoutMs);

    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimeoutMs === null) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
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
      console.error(`[TIMEOUT] CLI hard timeout after ${timeoutMs}ms${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"}`);
      if (pid) killProcessTree(child, pid, killGraceMs);
      doReject(new Error(`CLI hard timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimeoutMs === null) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
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
