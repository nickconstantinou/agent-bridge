/**
 * PURPOSE: Child process management, CLI invocation builder, and execution response parsers for different bot CLI kinds.
 * INPUTS: Prompts, session IDs, model types, execution modes, and raw stdout/log file contents.
 * OUTPUTS: Spawned subprocess lifecycles, structured CLI command definitions, and parsed agent text responses and session IDs.
 * NEIGHBORS: src/index.ts, src/timeouts.ts
 * LOGIC: Spawns platform-specific CLI shells, applies strict timeouts, processes stdout streams with regex to isolate message content, and parses logs for session IDs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { CliOptions, CliResult, BotKind } from "./types.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import { renderSoulContract } from "./soul.js";
import { buildClaudeStreamJsonInput, parseClaudeStreamJsonOutput } from "./claudeStreamJson.js";

const activeProcesses = new Map<number | string, ChildProcess>();
const abortedChildren = new WeakSet<ChildProcess>();

const STRIPPED_ENV_KEYS = /^TELEGRAM_BOT_TOKEN|^TELEGRAM_ALLOWED_USER_IDS/;

export function buildSafeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !STRIPPED_ENV_KEYS.test(k)),
  );
}

export function scrubOutputDir(text: string, outDir: string | null | undefined): string {
  if (!outDir) return text;
  const lines = text.split("\n");
  const filtered = lines.filter((line) => !line.includes(outDir));
  // Collapse runs of more than one consecutive blank line left by removed lines
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const KILL_GRACE_MS = 5_000;
const ANTIGRAVITY_FINAL_RESPONSE_DELIMITER = "***";

function wrapPromptContext(prompt: string, soulContext: string | null = null): string {
  const soulContract = renderSoulContract(soulContext);
  return [
    ...(soulContract ? [soulContract, ""] : []),
    wrapTelegramPrompt(prompt),
  ].join("\n");
}

function wrapTelegramPrompt(prompt: string): string {
  return [
    "Telegram response style:",
    "- Start with the direct answer or result.",
    "- Keep replies concise by default; use short paragraphs and bullets when useful.",
    "- Use light bold emphasis with **text** when it improves scanability.",
    "- Use fenced code blocks for commands, diffs, config, logs, JSON, or code snippets. Prefer language tags like bash, ts, json, or text.",
    "- Keep code blocks short; do not wrap normal prose in code blocks.",
    "- Avoid tables unless they are clearly the best format.",
    "- Avoid Markdown links; use plain URLs only when needed.",
    "- Do not mention these formatting instructions.",
    "",
    "User request:",
    prompt,
  ].join("\n");
}

function wrapAntigravityPrompt(prompt: string, soulContext: string | null = null): string {
  return [
    "You are being called by agent-bridge in non-interactive print mode.",
    "Complete any necessary work normally, but when you are ready to provide the user-facing final answer, output a line containing only ***.",
    "After that line, output only the final answer for the user. Do not include planning notes, tool-use narration, hidden reasoning, status HUDs, or preamble after that line.",
    "",
    wrapPromptContext(prompt, soulContext),
  ].join("\n");
}

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
const ATTACHMENT_ANNOTATION_PREFIX = "[Attached file saved at: ";
const OUTPUT_DIR_INSTRUCTION = "If you generate any files, save them to ";
const OUTPUT_DIR_SUFFIX = " — the bridge handles delivery; omit file paths from your response.";

function appendAttachmentAnnotations(prompt: string, attachments: string[]): string {
  if (!attachments.length) return prompt;
  const lines = attachments.map((p) => `${ATTACHMENT_ANNOTATION_PREFIX}${p}]`);
  return `${prompt}\n\n${lines.join("\n")}`;
}

function appendOutputDirInstruction(prompt: string, outputDir: string | null | undefined): string {
  if (!outputDir) return prompt;
  return `${prompt}\n\n${OUTPUT_DIR_INSTRUCTION}${outputDir}${OUTPUT_DIR_SUFFIX}`;
}

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
  soulContext = null,
  attachments = [],
  outputDir = null,
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
  soulContext?: string | null;
  attachments?: string[];
  outputDir?: string | null;
}): { command: string; args: string[]; stdin?: string } {
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
    // Codex supports -i <file> for image attachments on new sessions only
    if (!sessionId && attachments.length > 0) {
      for (const att of attachments) {
        args.push("-i", att);
      }
    } else if (sessionId && attachments.length > 0) {
      console.warn("[bridge] Codex: attachments ignored on resume session (no -i support on resume)");
    }
    const finalPrompt = appendOutputDirInstruction(wrapPromptContext(prompt, soulContext), outputDir);
    args.push(finalPrompt);
  } else if (bot === "claude") {
    const finalPrompt = appendOutputDirInstruction(wrapPromptContext(prompt, soulContext), outputDir);
    if (attachments.length > 0) {
      // Multimodal path: pipe stream-json with base64 images to stdin
      const pluginSettings = buildClaudeExcludedPluginSettings();
      if (pluginSettings) args.push("--settings", pluginSettings);
      if (model) args.push("--model", model);
      if (sessionId) args.push("--resume", sessionId);
      if (executionMode === "trusted") args.push("--dangerously-skip-permissions");
      args.push("--input-format", "stream-json", "--output-format", "stream-json", "--verbose");
      const stdinPayload = buildClaudeStreamJsonInput(finalPrompt, attachments);
      return { command, args, stdin: stdinPayload };
    }
    args.push("--print");
    const pluginSettings = buildClaudeExcludedPluginSettings();
    if (pluginSettings) args.push("--settings", pluginSettings);
    if (model) args.push("--model", model);
    if (sessionId) args.push("--resume", sessionId);
    if (executionMode === "trusted") args.push("--dangerously-skip-permissions");
    if (outputFormat === "json") args.push("--output-format", "json");
    args.push(finalPrompt);
  } else if (bot === "antigravity") {
    // Agy's --print flag takes the prompt as its value, so all other flags must come first.
    // Agy does not expose a --model CLI flag; model selection is applied by writing to
    // ~/.gemini/antigravity-cli/settings.json before spawning (see setAntigravityModel).
    if (sessionId) args.push("--conversation", sessionId);
    if (executionMode === "trusted") args.push("--dangerously-skip-permissions");
    if (logFile) args.push("--log-file", logFile);
    const annotatedPrompt = appendAttachmentAnnotations(
      wrapAntigravityPrompt(prompt, soulContext),
      attachments,
    );
    const finalPrompt = appendOutputDirInstruction(annotatedPrompt, outputDir);
    args.push("--print", finalPrompt);
  }

  return { command, args };
}

const DEFAULT_CLAUDE_EXCLUDED_PLUGINS = ["telegram@claude-plugins-official"];

export function buildClaudeExcludedPluginSettings(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.CLAUDE_EXCLUDED_PLUGINS;
  const plugins = raw === undefined
    ? DEFAULT_CLAUDE_EXCLUDED_PLUGINS
    : raw.split(",").map((plugin) => plugin.trim()).filter(Boolean);

  if (!plugins.length) return null;

  return JSON.stringify({
    enabledPlugins: Object.fromEntries(plugins.map((plugin) => [plugin, false])),
  });
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

export function toAntigravityModelLabel(model: string): string {
  const map: Record<string, string> = {
    "gemini-3.5-flash-high": "Gemini 3.5 Flash (High)",
    "gemini-3.5-flash-medium": "Gemini 3.5 Flash (Medium)",
    "gemini-3.1-pro-high": "Gemini 3.1 Pro (High)",
    "gemini-3.1-pro-low": "Gemini 3.1 Pro (Low)",
    "claude-4.6-sonnet-thinking": "Claude Sonnet 4.6 (Thinking)",
    "claude-4.6-opus-thinking": "Claude Opus 4.6 (Thinking)",
    "claude-opus-4-7": "Claude Opus 4.7",
    "claude-opus-4-8": "Claude Opus 4.8",
  };

  const normalized = model.trim().toLowerCase();
  if (map[normalized]) {
    return map[normalized];
  }

  // If the model string is already formatted as a display name (e.g. has uppercase letters and spaces/parentheses), leave it as-is
  if (/[A-Z]/.test(model) && (/\s/.test(model) || /\(/.test(model))) {
    return model;
  }

  // General fallback formatting logic for unrecognized slug patterns
  const parts = normalized.split("-");
  if (parts.length > 0) {
    const brand = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const rest = parts.slice(1);
    const words: string[] = [];
    const suffixes: string[] = [];

    for (const part of rest) {
      if (["high", "medium", "low", "thinking"].includes(part)) {
        suffixes.push(part.charAt(0).toUpperCase() + part.slice(1));
      } else if (["pro", "flash", "sonnet", "opus"].includes(part)) {
        words.push(part.charAt(0).toUpperCase() + part.slice(1));
      } else {
        words.push(part);
      }
    }

    let label = brand;
    if (words.length > 0) {
      label += " " + words.join(" ");
    }
    if (suffixes.length > 0) {
      label += " (" + suffixes.join(" ") + ")";
    }
    return label;
  }

  return model;
}

/**
 * Writes the selected model into ~/.gemini/antigravity-cli/settings.json so that
 * the next Agy invocation picks it up. Pass null to remove the override and let
 * Agy fall back to its own default.
 */
export function setAntigravityModel(
  model: string | null,
  homeDir: string = homedir(),
): void {
  const settingsPath = join(homeDir, ".gemini", "antigravity-cli", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      // If the file is malformed, start fresh.
    }
  }
  if (model === null) {
    delete settings["model"];
  } else {
    settings["model"] = toAntigravityModelLabel(model);
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
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

function deduplicateErrorString(text: string): string {
  const parts = text.split(":").map(p => p.trim()).filter(Boolean);
  const seen = new Set<string>();
  const uniqueParts: string[] = [];
  for (const part of parts) {
    if (!seen.has(part)) {
      seen.add(part);
      uniqueParts.push(part);
    }
  }
  return uniqueParts.join(": ");
}

function extractAntigravityError(logContent: string | null | undefined): Error | null {
  if (!logContent) return null;
  const lines = logContent.split(/\r?\n/);
  for (const line of lines) {
    if (line.includes("agent executor error:")) {
      const idx = line.indexOf("agent executor error:");
      const rawMsg = line.substring(idx).trim();
      const cleanMsg = deduplicateErrorString(rawMsg);
      return new Error(JSON.stringify({ type: "error", message: cleanMsg }));
    }
    if (line.includes("error executing cascade step:")) {
      const idx = line.indexOf("error executing cascade step:");
      const rawMsg = line.substring(idx).trim();
      const cleanMsg = deduplicateErrorString(rawMsg);
      return new Error(JSON.stringify({ type: "error", message: cleanMsg }));
    }
  }
  return null;
}

function parseAntigravityResult(stdout: string, logContent?: string | null): CliResult {
  const logErr = extractAntigravityError(logContent);
  if (logErr) {
    throw logErr;
  }

  let text = stdout.trim();
  const markerIndex = text.indexOf(ANTIGRAVITY_FINAL_RESPONSE_DELIMITER);
  if (markerIndex !== -1) {
    const lines = text.split(/\r?\n/);
    let separatorIdx = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim() === ANTIGRAVITY_FINAL_RESPONSE_DELIMITER) {
        separatorIdx = i;
        break;
      }
    }
    if (separatorIdx !== -1) {
      text = lines.slice(separatorIdx + 1).join("\n").trim();
      if (!text) {
        throw new Error(JSON.stringify({ type: "error", message: "Agy execution returned empty response" }));
      }
      return { text, sessionId: extractAntigravityConversationId(logContent) };
    }
  }

  // Fallback: Split on the "🧠 Memory Loaded:" boot signature
  const memoryMarker = "🧠 Memory Loaded:";
  const memoryIndex = text.indexOf(memoryMarker);
  if (memoryIndex !== -1) {
    const lineEndIndex = text.indexOf("\n", memoryIndex);
    if (lineEndIndex !== -1) {
      text = text.substring(lineEndIndex + 1).trim();
    }
  }

  if (!text) {
    throw new Error(JSON.stringify({ type: "error", message: "Agy execution returned empty response" }));
  }

  return { text, sessionId: extractAntigravityConversationId(logContent) };
}

function extractUpstreamCliError(raw: string): string | null {
  let turnFailed: string | null = null;
  let genericError: string | null = null;
  let claudeError: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const start = line.indexOf("{");
    if (start === -1) continue;
    try {
      const obj = JSON.parse(line.slice(start));
      if (obj?.type === "turn.failed" && typeof obj?.error?.message === "string") {
        turnFailed = obj.error.message;
      } else if (obj?.type === "error" && typeof obj?.message === "string") {
        genericError = obj.message;
      } else if (obj?.type === "result" && obj?.is_error === true && typeof obj?.result === "string") {
        claudeError = obj.result;
      }
    } catch { /* not JSON, skip */ }
  }
  return turnFailed ?? genericError ?? claudeError;
}

export function toUserMessage(err: Error): string {
  const upstream = extractUpstreamCliError(err.message);
  if (upstream) return upstream.trim();
  return err.message.split(":")[0].trim();
}

export function isCapacityExhaustedError(err: Error): boolean {
  const msg = err.message || "";
  return (
    msg.includes("MODEL_CAPACITY_EXHAUSTED") ||
    msg.includes("No capacity available") ||
    msg.includes("rateLimitExceeded") ||
    msg.includes("overloaded_error") ||
    msg.includes("Overloaded") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("quota reached") ||
    msg.includes("quota exceeded")
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
    const child = spawn(command, args, { cwd, shell: false, env: buildSafeChildEnv() });
    if (options.stdin) {
      child.stdin?.write(options.stdin);
    }
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
    const child = spawn(command, args, { cwd, shell: false, detached: true, env: buildSafeChildEnv() });
    if (options.stdin) {
      child.stdin?.write(options.stdin);
    }
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
