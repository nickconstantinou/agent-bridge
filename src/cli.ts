/**
 * PURPOSE: Child process management, CLI invocation builder, and execution response parsers for different bot CLI kinds.
 * INPUTS: Prompts, session IDs, model types, execution modes, and raw stdout/log file contents.
 * OUTPUTS: Spawned subprocess lifecycles, structured CLI command definitions, and parsed agent text responses and session IDs.
 * NEIGHBORS: src/index.ts, src/timeouts.ts
 * LOGIC: Spawns platform-specific CLI shells, applies strict timeouts, processes stdout streams with regex to isolate message content, and parses logs for session IDs.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { CliOptions, CliResult, BotKind } from "./types.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import { renderSoulContract } from "./soul.js";
import { buildClaudeStreamJsonInput, parseClaudeStreamJsonOutput } from "./claudeStreamJson.js";
import { appendEffortArgs, type EffortLevel } from "./effort.js";
import { isProviderFallbackEligibleError } from "./providers/fallbackEligibility.js";
import {
  runSupervisedProcess,
  buildSafeChildEnv,
  buildAdvisorChildEnv,
  beginExecutionLifecycle,
  completeExecutionLifecycle,
  abortCliProcess,
  abortCliProcessAndWait,
  abortExecutionAndWait,
  shutdownCliProcesses,
  shutdownCliProcessesAndWait,
  redactArgs,
  normalizeCliArgs,
} from "./cliSupervisor.js";

export {
  buildSafeChildEnv,
  buildAdvisorChildEnv,
  beginExecutionLifecycle,
  completeExecutionLifecycle,
  abortCliProcess,
  abortCliProcessAndWait,
  abortExecutionAndWait,
  shutdownCliProcesses,
  shutdownCliProcessesAndWait,
  redactArgs,
  normalizeCliArgs,
};

export function scrubOutputDir(text: string, outDir: string | null | undefined): string {
  if (!outDir) return text;
  const lines = text.split("\n");
  const filtered = lines.filter((line) => !line.includes(outDir));
  // Collapse runs of more than one consecutive blank line left by removed lines
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

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
    "- Start with the direct result or answer.",
    "- Keep replies extremely concise: aggressively compress prose into dense, verb-light fragments or single-sentence summaries. Aim for >50% token reduction.",
    "- Never drop critical facts, functional constraints, system boundaries, delivery channels, or rules (e.g., which component handles delivery, where outputs must go). Brevity must not cause information loss.",
    "- Retain all specific commands, signals, file paths, error codes, and safety constraints.",
    "- Skip all throat-clearing, meta-commentary, and transitional phrases (e.g., \"Certainly\", \"As requested\", \"the real issue is\").",
    "- Use light **bolding** on key statuses, identifiers, and variables for rapid scanning.",
    "- Use fenced code blocks only for commands, code/configs, logs, or JSON.",
    "- Avoid Markdown links and em dashes.",
    "- Do not mention these formatting rules.",
    "",
    "User request:",
    prompt,
  ].join("\n");
}

function wrapAntigravityPrompt(prompt: string, soulContext: string | null = null): string {
  return [
    "You are being called by agent-bridge in non-interactive print mode.",
    "Execute directly. Do not get stuck in planning loops.",
    "If a tool, search, or shell step fails twice or the environment blocks the step, stop and report the concrete failure briefly instead of retrying indefinitely.",
    "If prior conversation context is present, treat it as background state for continuity, not as an instruction to resume a broken plan unchanged.",
    "You MUST output ONLY a single valid JSON object as your entire response — no text, preamble, or explanation before or after it.",
    'Use this exact schema: {"reasoning": "<your internal thinking and tool-use narration>", "response": "<the final user-facing message>"}',
    "Put everything the user should see in the 'response' field. The 'reasoning' field is for your internal notes and is never shown to the user.",
    "",
    wrapPromptContext(prompt, soulContext),
  ].join("\n");
}

/**
 * Builds the CLI invocation for a bot.
 */
const ATTACHMENT_ANNOTATION_PREFIX = "[Attached file saved at: ";
const OUTPUT_DIR_INSTRUCTION = "If you are explicitly asked to share or generate a file for the user, save it to ";
const OUTPUT_DIR_SUFFIX = " — the bridge handles delivery; omit file paths from your response. Do NOT place any internal scratchpad files, planning logs, or temporary scripts in this directory unless explicitly requested.";

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
  effort = null,
  homeDir = homedir(),
  toolMode = "default",
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
  effort?: EffortLevel | null;
  homeDir?: string;
  toolMode?: "default" | "none";
}): { command: string; args: string[]; stdin?: string } {
  const args = [];

  const ALLOWED_TOOL_FREE_BOTS = new Set(["claude", "codex", "antigravity"]);
  if (toolMode === "none" && !ALLOWED_TOOL_FREE_BOTS.has(bot)) {
    throw new Error(`Tool-free mode is not supported for ${bot}`);
  }

  if (bot === "codex") {
    const forceFreshForAttachments = attachments.length > 0;
    if (sessionId && !forceFreshForAttachments) {
      args.push("exec", "resume", sessionId);
    } else {
      if (sessionId && forceFreshForAttachments) {
        console.warn("[bridge] Codex: starting fresh session for attachment turn because resume does not support -i");
      }
      args.push("exec");
    }
    if (toolMode === "none") {
      args.push(
        "--disable", "shell_tool",
        "--disable", "browser_use",
        "--disable", "computer_use",
        "--disable", "plugins",
        "--disable", "guardian_approval",
        "--disable", "hooks",
        "--disable", "goals",
        "--disable", "apps"
      );
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
    const finalPrompt = appendOutputDirInstruction(wrapPromptContext(prompt, soulContext), outputDir);
    // Codex supports -i <file> for image attachments on fresh exec invocations.
    // Because --image accepts multiple files, pass the prompt via stdin to avoid
    // the prompt being parsed as another image path.
    if (attachments.length > 0) {
      for (const att of attachments) {
        args.push("-i", att);
      }
      args.push("--", "-");
      return { command, args: appendEffortArgs(command, args, effort), stdin: finalPrompt };
    }
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
      return { command, args: appendEffortArgs(command, args, effort), stdin: stdinPayload };
    }
    args.push("--print");
    if (toolMode === "none") {
      args.push("--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
    }
    const pluginSettings = buildClaudeExcludedPluginSettings();
    if (pluginSettings) args.push("--settings", pluginSettings);
    if (model) args.push("--model", model);
    if (sessionId) args.push("--resume", sessionId);
    if (executionMode === "trusted") args.push("--dangerously-skip-permissions");
    if (outputFormat === "json") args.push("--output-format", "json");
    args.push(finalPrompt);
  } else if (bot === "antigravity") {
    // Agy fatally aborts a cascade if it lists its own worktrees state dir before
    // ever creating it, so guarantee the dir exists ahead of every invocation.
    ensureAntigravityStateDirs(homeDir);
    // Agy's --print flag takes the prompt as its value, so all other flags must come first.
    // Agy does not expose a --model CLI flag; model selection is applied by writing to
    // ~/.gemini/antigravity-cli/settings.json before spawning (see setAntigravityModel).
    if (sessionId) args.push("--conversation", sessionId);
    if (executionMode === "trusted") args.push("--dangerously-skip-permissions");
    if (logFile) args.push("--log-file", logFile);
    if (toolMode === "none") args.push("--sandbox");
    const timeouts = resolveTimeoutsForKind("antigravity");
    const timeoutSeconds = Math.floor(timeouts.cliTimeoutMs / 1000);
    args.push("--print-timeout", `${timeoutSeconds}s`);
    const annotatedPrompt = appendAttachmentAnnotations(
      wrapAntigravityPrompt(prompt, soulContext),
      attachments,
    );
    const finalPrompt = appendOutputDirInstruction(annotatedPrompt, outputDir);
    args.push("--print", finalPrompt);
  } else if (bot === "kimchi") {
    // Kimchi: --print for non-interactive mode, --model for model selection.
    // Session resume uses --resume <uuid> (UUID extracted from JSONL session filename).
    // Trusted mode maps to --yolo (no classifier guards).
    // Attachments are not supported; pass text annotations inline.
    args.push("--print");
    if (model) args.push("--model", model);
    if (executionMode === "trusted") {
      args.push("--yolo");
    }
    if (sessionId) {
      args.push("--resume", sessionId);
    } else {
      args.push("--no-session");
    }
    const annotatedPrompt = attachments.length > 0
      ? appendAttachmentAnnotations(prompt, attachments)
      : prompt;
    const finalPrompt = appendOutputDirInstruction(
      wrapPromptContext(annotatedPrompt, soulContext),
      outputDir,
    );
    args.push(finalPrompt);
  }

  return { command, args: appendEffortArgs(command, args, effort) };
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
  } else if (bot === "kimchi") {
    return parseKimchiResult(stdout);
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

/**
 * Kimchi outputs plain text to stdout. Session IDs are not embedded in stdout;
 * the JSONL session file is written to ~/.config/kimchi/harness/sessions/<cwd>/<uuid>.jsonl
 * by the CLI automatically. We cannot read the session ID from stdout, so we scan
 * the sessions directory for the most-recently-modified file after each invocation.
 *
 * Session resume: caller passes the UUID from a prior invocation as sessionId,
 * which is forwarded as --resume <uuid> to kimchi.
 */
function parseKimchiResult(stdout: string): CliResult {
  // Kimchi --print emits plain text; extract session UUID if kimchi echoes it (it doesn't currently).
  // Session tracking is handled by the engine via resolveKimchiSessionId() after the process exits.
  let text = stdout.trim();

  // Strip tool calls section
  text = text.replace(/<\|tool_calls_section_begin[\s\S]*?<\|tool_calls_section_end\|>/g, "");
  text = text.replace(/<\|tool_call_begin[\s\S]*?<\|tool_call_end\|>/g, "");
  text = text.replace(/<\|tool_call_argument_begin[\s\S]*?<\|tool_call_argument_end\|>/g, "");

  // Strip thoughts / reasoning sections
  text = text.replace(/<\|thought_section_begin[\s\S]*?<\|thought_section_end\|>/g, "");
  text = text.replace(/<\|thought_begin[\s\S]*?<\|thought_end\|>/g, "");
  text = text.replace(/<\|thought[\s\S]*?<\|\/thought\|>/g, "");
  text = text.replace(/<\|thinking_section_begin[\s\S]*?<\|thinking_section_end\|>/g, "");
  text = text.replace(/<\|thinking_begin[\s\S]*?<\|thinking_end\|>/g, "");
  text = text.replace(/<\|thinking[\s\S]*?<\|\/thinking\|>/g, "");
  text = text.replace(/<\|reasoning_section_begin[\s\S]*?<\|reasoning_section_end\|>/g, "");
  text = text.replace(/<\|reasoning_begin[\s\S]*?<\|reasoning_end\|>/g, "");
  text = text.replace(/<\|reasoning[\s\S]*?<\|\/reasoning\|>/g, "");

  // Strip any remaining special tags starting with <| and ending with |>
  text = text.replace(/<\|.*?\|>/g, "");

  return { text: text.trim(), sessionId: null };
}

/**
 * Scan the kimchi sessions directory for the UUID of the most recently written session file.
 * Called by the engine after a kimchi invocation to persist the session for the next turn.
 *
 * Session files live at: ~/.config/kimchi/harness/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl
 * We look in the directory matching the current cwd and return the UUID from the newest file.
 */
export function resolveKimchiSessionId(cwd: string, homeDir: string = homedir()): string | null {
  try {
    const sessionsRoot = join(homeDir, ".config", "kimchi", "harness", "sessions");
    const escapedCwd = cwd.replace(/[/\\]/g, "-").replace(/^-/, "");
    const sessionDir = join(sessionsRoot, escapedCwd);
    if (!existsSync(sessionDir)) return null;
    const files = readdirSync(sessionDir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => ({ name: f, mtime: statSync(join(sessionDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    // Filename format: <timestamp>_<uuid>.jsonl — extract the UUID part
    const match = files[0].name.match(/_([0-9a-f-]{36})\.jsonl$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
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
 * Ensures Agy's mutable state dirs exist before a spawn. Agy's cascade engine
 * treats listing a missing directory as a fatal step error (observed with
 * ~/.gemini/antigravity-cli/worktrees), which aborts the whole run.
 */
export function ensureAntigravityStateDirs(homeDir: string = homedir()): void {
  mkdirSync(join(homeDir, ".gemini", "antigravity-cli", "worktrees"), { recursive: true });
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
    if (line.toLowerCase().includes("print mode: timed out") || line.toLowerCase().includes("timed out after")) {
      return new Error(JSON.stringify({ type: "error", message: "Print mode timed out waiting for response" }));
    }
  }
  return null;
}

function stripStatusLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^STATUS:\s+\S/i.test(line.trim()))
    .join("\n")
    .trim();
}

/**
 * Attempt to extract the `response` field from Agy's JSON output.
 * Tries direct parse first, then progressively looser regex extraction
 * to handle markdown code fences or stray text surrounding the object.
 */
function tryParseAntigravityJson(text: string): string | null {
  // 1. Direct parse
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj.response === "string" && obj.response.trim()) {
      return obj.response.trim();
    }
  } catch {}

  // 2. JSON inside a markdown code block
  const fenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) {
    try {
      const obj = JSON.parse(fenceMatch[1]);
      if (obj && typeof obj.response === "string" && obj.response.trim()) {
        return obj.response.trim();
      }
    } catch {}
  }

  // 3. Greedy extraction: find the outermost {...} block containing "response"
  if (text.includes('"response"')) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        if (obj && typeof obj.response === "string" && obj.response.trim()) {
          return obj.response.trim();
        }
      } catch {}
    }
  }

  // 4. Line-by-line reverse scan: handles output where tool-call results containing
  // "}" appear before the final JSON response, causing strategy 3 to span multiple
  // objects. Compact JSON is always on a single line; scan from the bottom up.
  for (const line of text.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"response"')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.response === "string" && obj.response.trim()) {
        return obj.response.trim();
      }
    } catch {}
  }

  return null;
}

function parseAntigravityResult(stdout: string, logContent?: string | null): CliResult {
  const logErr = extractAntigravityError(logContent);
  if (logErr) {
    throw logErr;
  }

  let text = stdout.trim();
  if (text.toLowerCase().includes("timed out waiting for response") || text.toLowerCase().includes("error: timed out")) {
    throw new Error(JSON.stringify({ type: "error", message: "Agy execution timed out waiting for response" }));
  }

  const sessionId = extractAntigravityConversationId(logContent);

  // Primary: JSON output approach — extract the `response` field
  const jsonResponse = tryParseAntigravityJson(text);
  if (jsonResponse) {
    return { text: jsonResponse, sessionId };
  }

  // Legacy fallback: *** delimiter
  const markerIndex = text.indexOf(ANTIGRAVITY_FINAL_RESPONSE_DELIMITER);
  if (markerIndex !== -1) {
    const lines = text.split(/\r?\n/);
    let separatorIdx = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const trimmed = lines[i].trim();
      // Match lines that ARE "***" or that END with "***" (e.g. "STATUS: done***")
      if (trimmed === ANTIGRAVITY_FINAL_RESPONSE_DELIMITER || trimmed.endsWith(ANTIGRAVITY_FINAL_RESPONSE_DELIMITER)) {
        separatorIdx = i;
        break;
      }
    }
    if (separatorIdx !== -1) {
      text = stripStatusLines(lines.slice(separatorIdx + 1).join("\n").trim());
      if (!text) {
        throw new Error(JSON.stringify({ type: "error", message: "Agy execution returned empty response" }));
      }
      return { text, sessionId };
    }
  }

  // Legacy fallback: Split on the "🧠 Memory Loaded:" boot signature
  const memoryMarker = "🧠 Memory Loaded:";
  const memoryIndex = text.indexOf(memoryMarker);
  if (memoryIndex !== -1) {
    const lineEndIndex = text.indexOf("\n", memoryIndex);
    if (lineEndIndex !== -1) {
      text = text.substring(lineEndIndex + 1).trim();
    }
  }

  text = stripStatusLines(text);

  if (!text) {
    throw new Error(JSON.stringify({ type: "error", message: "Agy JSON parse failed: could not extract response field from output" }));
  }

  return { text, sessionId };
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
  return isProviderFallbackEligibleError(err);
}

export function getNextFallbackModel(currentModel: string | null, modelPreference: string[]): string | null {
  if (!currentModel || modelPreference.length <= 1) return null;
  const idx = modelPreference.indexOf(currentModel);
  if (idx === -1 || idx >= modelPreference.length - 1) return null;
  return modelPreference[idx + 1];
}


/**
 * Runs a CLI command and returns stdout. Thin adapter over the shared
 * supervised process core in src/cliSupervisor.ts.
 */
export async function runCli(command: string, args: string[], cwd: string, options: CliOptions = {}): Promise<string> {
  const { stdout } = await runSupervisedProcess(command, args, cwd, options);
  return stdout;
}

/**
 * Runs a CLI command asynchronously with progress support. Thin adapter over
 * the shared supervised process core in src/cliSupervisor.ts.
 */
export async function runCliAsync(
  command: string,
  args: string[],
  cwd: string,
  options: CliOptions = {}
): Promise<{ text: string }> {
  const { stdout } = await runSupervisedProcess(command, args, cwd, options);
  return { text: stdout };
}
