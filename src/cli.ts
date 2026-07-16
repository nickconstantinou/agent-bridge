/**
 * PURPOSE: Child process management, CLI invocation builder, and execution response parsers for different bot CLI kinds.
 * INPUTS: Prompts, session IDs, model types, execution modes, and raw stdout/log file contents.
 * OUTPUTS: Spawned subprocess lifecycles, structured CLI command definitions, and parsed agent text responses and session IDs.
 * NEIGHBORS: src/index.ts, src/timeouts.ts
 * LOGIC: Spawns platform-specific CLI shells, applies strict timeouts, processes stdout streams with regex to isolate message content, and parses logs for session IDs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import type { CliOptions, CliResult, BotKind } from "./types.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import { renderSoulContract } from "./soul.js";
import { buildClaudeStreamJsonInput, parseClaudeStreamJsonOutput } from "./claudeStreamJson.js";
import { type as evtType } from "./events/types.js";
import type { BridgeEvent } from "./events/types.js";
import { appendEffortArgs, type EffortLevel } from "./effort.js";
import { isProviderFallbackEligibleError } from "./providers/fallbackEligibility.js";
import type { ExecutionLaneHandle } from "./db.js";
import { buildWorkspaceLockedInvocation } from "./workspaceLock.js";

interface ActiveExecution {
  child: ChildProcess | null;
  lifecycleToken: string | null;
  lifecycleHandle: ExecutionLaneHandle | null;
  lifecycleDone: Promise<void> | null;
  finishLifecycle: (() => void) | null;
}

const activeExecutions = new Map<number | string, ActiveExecution>();
const abortedChildren = new WeakSet<ChildProcess>();

const STRIPPED_ENV_KEYS = /^TELEGRAM_BOT_TOKEN|^TELEGRAM_ALLOWED_USER_IDS/;
const ADVISOR_SECRET_ENV_KEYS = /^(?:AGENT_)?BRIDGE_.*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;

export function buildSafeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !STRIPPED_ENV_KEYS.test(k)),
  );
}

export function buildAdvisorChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(buildSafeChildEnv(env)).filter(([key]) =>
      !key.startsWith("AGENT_BRIDGE_ADVISOR_")
      && !key.startsWith("BRIDGE_ADVISOR_")
      && !ADVISOR_SECRET_ENV_KEYS.test(key),
    ),
  );
}

function buildChildEnv(extraEnv?: Record<string, string>, advisorChild = false): NodeJS.ProcessEnv {
  const base = advisorChild ? buildAdvisorChildEnv() : buildSafeChildEnv();
  const merged = {
    ...base,
    ...(extraEnv ?? {}),
  };
  return advisorChild ? buildAdvisorChildEnv(merged) : merged;
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
const ANTIGRAVITY_STALLED_PLANNER_MARKER = "PlannerResponse without ModifiedResponse encountered";

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

function getAntigravityStalledPlannerTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ANTIGRAVITY_STALLED_PLANNER_TIMEOUT_MS || 300_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

function extractLogFileArg(args: string[]): string | null {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === "--log-file") return args[i + 1] || null;
  }
  return null;
}

function createAntigravityPlannerStallWatch(args: string[], stdoutRef: () => string, onStall: () => void): NodeJS.Timeout | null {
  const logFile = extractLogFileArg(args);
  if (!logFile) return null;
  const stallTimeoutMs = getAntigravityStalledPlannerTimeoutMs();
  const startedAt = Date.now();
  const intervalMs = Math.max(250, Math.min(stallTimeoutMs, 1_000));

  return setInterval(() => {
    if (stdoutRef().trim()) return;
    if (Date.now() - startedAt < stallTimeoutMs) return;

    let logContent = "";
    try {
      logContent = readFileSync(logFile, "utf8");
    } catch {
      return;
    }

    if (logContent.includes(ANTIGRAVITY_STALLED_PLANNER_MARKER)) {
      onStall();
    }
  }, intervalMs);
}

/**
 * Removes a chat's process registration only if it still points at this child.
 * A retry/fallback spawn may have re-registered the same chatId; a late close
 * from the older child must not deregister the newer process.
 */
function deregisterProcess(chatId: number | string, child: ChildProcess): void {
  const active = activeExecutions.get(chatId);
  if (active?.child === child) {
    active.child = null;
    if (!active.lifecycleToken) activeExecutions.delete(chatId);
  }
}

function registerProcess(chatId: number | string, child: ChildProcess): void {
  const active = activeExecutions.get(chatId);
  if (active) active.child = child;
  else activeExecutions.set(chatId, { child, lifecycleToken: null, lifecycleHandle: null, lifecycleDone: null, finishLifecycle: null });
}

export function beginExecutionLifecycle(chatId: number | string, handle: ExecutionLaneHandle): string {
  const token = randomUUID();
  let finishLifecycle!: () => void;
  const lifecycleDone = new Promise<void>((resolve) => { finishLifecycle = resolve; });
  const active = activeExecutions.get(chatId);
  activeExecutions.set(chatId, {
    child: active?.child ?? null,
    lifecycleToken: token,
    lifecycleHandle: handle,
    lifecycleDone,
    finishLifecycle,
  });
  return token;
}

export function completeExecutionLifecycle(chatId: number | string, token: string): void {
  const active = activeExecutions.get(chatId);
  if (!active || active.lifecycleToken !== token) return;
  active.finishLifecycle?.();
  active.lifecycleToken = null;
  active.lifecycleHandle = null;
  active.lifecycleDone = null;
  active.finishLifecycle = null;
  if (!active.child) activeExecutions.delete(chatId);
}

export function abortCliProcess(chatId: number | string): boolean {
  const child = activeExecutions.get(chatId)?.child;
  if (!child) return false;
  killChild(child);
  return true;
}

export function abortCliProcessAndWait(chatId: number | string): Promise<boolean> {
  const child = activeExecutions.get(chatId)?.child;
  if (!child) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = () => resolve(true);
    child.once("close", done);
    child.once("error", done);
    killChild(child);
  });
}

export async function abortExecutionAndWait(chatId: number | string): Promise<ExecutionLaneHandle | null> {
  const active = activeExecutions.get(chatId);
  if (!active) return null;
  const handle = active.lifecycleHandle;
  if (active.child) await abortCliProcessAndWait(chatId);
  await active.lifecycleDone;
  return handle;
}

export function shutdownCliProcesses(): number {
  const children = [...activeExecutions.values()].flatMap((active) => active.child ? [active.child] : []);
  for (const child of children) {
    killChild(child);
  }
  const count = children.length;
  activeExecutions.clear();
  return count;
}

/** Test/process teardown variant that does not return until every tracked child exits. */
export async function shutdownCliProcessesAndWait(): Promise<number> {
  const children = [...new Set(
    [...activeExecutions.values()].flatMap((active) => active.child ? [active.child] : []),
  )];
  const exits = children.map((child) => new Promise<void>((resolve) => {
    const done = () => resolve();
    child.once("close", done);
    child.once("error", done);
  }));
  for (const child of children) {
    abortedChildren.add(child);
    killWithGrace(child, 100);
  }
  await Promise.all(exits);
  for (const [chatId, active] of activeExecutions) {
    if (!active.child && !active.lifecycleToken) activeExecutions.delete(chatId);
  }
  return children.length;
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

const PROMPT_REDACT_THRESHOLD = 100;

/** Replaces any arg longer than PROMPT_REDACT_THRESHOLD with a size-only placeholder. */
export function redactArgs(args: string[]): string[] {
  return args.map((arg) =>
    arg.length > PROMPT_REDACT_THRESHOLD ? `[prompt: ${arg.length}chars]` : arg
  );
}

function formatSpawnLog(command: string, args: string[], cwd: string, chatId?: number | string, stdin?: string): string {
  const safeArgs = redactArgs(args).map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ");
  const chatPart = chatId != null ? ` chatId=${String(chatId)}` : "";
  const stdinPart = stdin ? ` stdin=[${stdin.length}chars]` : "";
  return `[spawn]${chatPart} cwd=${cwd} command=${command} args=${safeArgs}${stdinPart}`;
}

/**
 * Runs a CLI command and returns stdout.
 */
export async function runCli(command: string, args: string[], cwd: string, options: CliOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? null;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const onEvent = options.onEvent;
  const evtCtx = options.eventContext;

  const emit = (e: BridgeEvent) => {
    try {
      if (e.type === "run.started") {
        console.log(`[event] run.started runId=${e.runId} bot=${e.bot} chatId=${e.chatId}`);
      } else if (e.type === "run.completed") {
        console.log(`[event] run.completed runId=${e.runId} sessionId=${e.sessionId}`);
      } else if (e.type === "run.failed") {
        console.log(`[event] run.failed runId=${e.runId} category=${e.category} error="${e.error.replace(/\n/g, " ")}"`);
      } else if (e.type === "run.cancelled") {
        console.log(`[event] run.cancelled runId=${e.runId} reason=${e.reason}`);
      }
      onEvent?.(e);
    } catch {
      /* never let event emission break execution */
    }
  };

  return new Promise((resolve, reject) => {
    const normalizedArgs = normalizeCliArgs(command, args);
    const spawnInvocation = buildWorkspaceLockedInvocation(command, normalizedArgs, cwd);
    console.log(formatSpawnLog(command, normalizedArgs, cwd, options.chatId, options.stdin));
    // detached:true puts the child in its own process group so timeout kills
    // can signal the whole subtree (process.kill(-pid)) instead of stranding
    // grandchildren, mirroring runCliAsync.
    const child = spawn(spawnInvocation.command, spawnInvocation.args, { cwd, shell: false, detached: true, env: buildChildEnv(options.contextEnv, options.advisorChild) });
    if (options.stdin) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
    if (options.chatId != null) registerProcess(options.chatId, child);
    const pid = child.pid;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let pendingError: Error | null = null;

    if (evtCtx) emit(evtType.runStarted({ ...evtCtx, command, cwd, model: null }));

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
      if (settled || pendingError) return;
      console.error(`[HARD TIMEOUT] CLI hard timeout after ${timeoutMs}ms - killing process\n${formatSpawnLog(command, args, cwd, options.chatId)}`);
      if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: `CLI hard timeout after ${timeoutMs}ms`, category: "timeout" }));
      pendingError = new Error(`CLI hard timeout after ${timeoutMs}ms`);
      if (pid) killProcessTree(child, pid, killGraceMs); else killWithGrace(child, killGraceMs);
    }, timeoutMs);

    let plannerStallTriggered = false;
    const plannerStallTimer = command.includes("agy") || command.includes("antigravity")
      ? createAntigravityPlannerStallWatch(normalizedArgs, () => stdout, () => {
          if (plannerStallTriggered || settled || pendingError) return;
          plannerStallTriggered = true;
          console.error(`[AGY STALL] Planner churn detected without usable output${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""}`);
          if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: "Agy stalled in planner loop without usable output", category: "timeout" }));
          pendingError = new Error("Agy stalled in planner loop without usable output");
          if (pid) killProcessTree(child, pid, killGraceMs); else killWithGrace(child, killGraceMs);
        })
      : null;

    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimeoutMs === null) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled || pendingError) return;
        console.error(`[IDLE TIMEOUT] CLI idle timeout after ${idleTimeoutMs}ms with no stdout/stderr${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""}`);
        if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: `CLI idle timeout after ${idleTimeoutMs}ms`, category: "timeout" }));
        pendingError = new Error(`CLI idle timeout after ${idleTimeoutMs}ms`);
        if (pid) killProcessTree(child, pid, killGraceMs); else killWithGrace(child, killGraceMs);
      }, idleTimeoutMs);
    };

    resetIdleTimer();

    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      resetIdleTimer();
      if (evtCtx) emit(evtType.textDelta({ ...evtCtx, text: chunk, source: "stdout" }));
    });

    child.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      console.error(`[stderr]${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"} ${chunk.trimEnd()}`);
      resetIdleTimer();
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (plannerStallTimer) clearInterval(plannerStallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (options.chatId != null) deregisterProcess(options.chatId, child);
      console.log(`[close]${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"} code=${code} signal=${signal ?? "none"}`);

      if (settled) return;
      if (pendingError) {
        doReject(pendingError);
        return;
      }

      if (signal && abortedChildren.has(child)) {
        if (evtCtx) emit(evtType.runCancelled({ ...evtCtx, reason: "user" }));
        doResolve(stdout);
      } else if (signal) {
        if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: `CLI killed by signal ${signal}`, category: "cli" }));
        const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        doReject(new Error(`CLI killed by signal ${signal}: ${combined}`));
      } else if (code !== 0 && code !== null) {
        if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: `CLI exited with code ${code}`, category: "cli" }));
        const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        doReject(new Error(`CLI exited with code ${code}: ${combined}`));
      } else {
        if (evtCtx) emit(evtType.runCompleted({ ...evtCtx, text: stdout, sessionId: null }));
        doResolve(stdout);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (plannerStallTimer) clearInterval(plannerStallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (options.chatId != null) deregisterProcess(options.chatId, child);
      if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: err.message, category: "cli" }));
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
  const onEvent = options.onEvent;
  const evtCtx = options.eventContext;

  const emit = (e: BridgeEvent) => {
    try {
      if (e.type === "run.started") {
        console.log(`[event] run.started runId=${e.runId} bot=${e.bot} chatId=${e.chatId}`);
      } else if (e.type === "run.completed") {
        console.log(`[event] run.completed runId=${e.runId} sessionId=${e.sessionId}`);
      } else if (e.type === "run.failed") {
        console.log(`[event] run.failed runId=${e.runId} category=${e.category} error="${e.error.replace(/\n/g, " ")}"`);
      } else if (e.type === "run.cancelled") {
        console.log(`[event] run.cancelled runId=${e.runId} reason=${e.reason}`);
      }
      onEvent?.(e);
    } catch {
      /* never let event emission break execution */
    }
  };

  const normalizedArgs = normalizeCliArgs(command, args);
  return new Promise((resolve, reject) => {
    const spawnInvocation = buildWorkspaceLockedInvocation(command, normalizedArgs, cwd);
    console.log(formatSpawnLog(command, normalizedArgs, cwd, options.chatId, options.stdin));
    const child = spawn(spawnInvocation.command, spawnInvocation.args, { cwd, shell: false, detached: true, env: buildChildEnv(options.contextEnv, options.advisorChild) });
    if (options.stdin) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
    if (options.chatId != null) registerProcess(options.chatId, child);
    const pid = child.pid;
    let settled = false;

    if (evtCtx) emit(evtType.runStarted({ ...evtCtx, command, cwd, model: null }));

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
    let pendingError: Error | null = null;

    const timer = setTimeout(() => {
      if (settled || pendingError) return;
      console.error(`[HARD TIMEOUT] CLI hard timeout after ${timeoutMs}ms${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"}`);
      if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: `CLI hard timeout after ${timeoutMs}ms`, category: "timeout" }));
      pendingError = new Error(`CLI hard timeout after ${timeoutMs}ms`);
      if (pid) killProcessTree(child, pid, killGraceMs);
    }, timeoutMs);

    let plannerStallTriggered = false;
    const plannerStallTimer = command.includes("agy") || command.includes("antigravity")
      ? createAntigravityPlannerStallWatch(normalizedArgs, () => stdout, () => {
          if (plannerStallTriggered || settled || pendingError) return;
          plannerStallTriggered = true;
          console.error(`[AGY STALL] Planner churn detected without usable output${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"}`);
          if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: "Agy stalled in planner loop without usable output", category: "timeout" }));
          pendingError = new Error("Agy stalled in planner loop without usable output");
          if (pid) killProcessTree(child, pid, killGraceMs);
        })
      : null;

    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimeoutMs === null) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (settled || pendingError) return;
        console.error(`[IDLE TIMEOUT] CLI idle timeout after ${idleTimeoutMs}ms with no stdout/stderr${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"}`);
        if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: `CLI idle timeout after ${idleTimeoutMs}ms`, category: "timeout" }));
        pendingError = new Error(`CLI idle timeout after ${idleTimeoutMs}ms`);
        if (pid) killProcessTree(child, pid, killGraceMs);
      }, idleTimeoutMs);
    };
    resetIdleTimer();

    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      resetIdleTimer();
      if (onProgress) onProgress(chunk);
      if (evtCtx) emit(evtType.textDelta({ ...evtCtx, text: chunk, source: "stdout" }));
    });

    child.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      console.error(`[stderr]${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"} ${chunk.trimEnd()}`);
      resetIdleTimer();
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (plannerStallTimer) clearInterval(plannerStallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (options.chatId != null) deregisterProcess(options.chatId, child);
      console.log(`[close]${options.chatId != null ? ` chatId=${String(options.chatId)}` : ""} pid=${pid ?? "?"} code=${code} signal=${signal ?? "none"}`);
      if (settled) return;
      if (pendingError) {
        doReject(pendingError);
        return;
      }

      if (signal && abortedChildren.has(child)) {
        if (evtCtx) emit(evtType.runCancelled({ ...evtCtx, reason: "user" }));
        doResolve({ text: stdout });
      } else if (signal) {
        if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: `CLI killed by signal ${signal}`, category: "cli" }));
        const combined = [stderr.trim(), stdout.slice(-2000).trim()].filter(Boolean).join("\n");
        doReject(new Error(`CLI killed by signal ${signal}: ${combined}`));
      } else if (code !== 0 && code !== null) {
        if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: `CLI exited with code ${code}`, category: "cli" }));
        const combined = [stderr.trim(), stdout.slice(-2000).trim()].filter(Boolean).join("\n");
        doReject(new Error(`CLI exited with code ${code}: ${combined}`));
      } else {
        if (evtCtx) emit(evtType.runCompleted({ ...evtCtx, text: stdout, sessionId: null }));
        doResolve({ text: stdout });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (plannerStallTimer) clearInterval(plannerStallTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (options.chatId != null) deregisterProcess(options.chatId, child);
      if (evtCtx) emit(evtType.runFailed({ ...evtCtx, error: err.message, category: "cli" }));
      doReject(err);
    });
  });
}

export function normalizeCliArgs(command: string, args: string[]): string[] {
  const cmdName = basename(command).toLowerCase();
  const isAgy = cmdName.includes("agy") || cmdName.includes("antigravity");
  const isCodex = cmdName.includes("codex");

  if (!isAgy && !isCodex) {
    return args;
  }

  // Parse original args to extract prompt, permissions, and output-format
  let prompt = "";
  let conversationId: string | null = null;
  let logFile: string | null = null;
  let printTimeout: string | null = null;
  let model: string | null = null;
  let effort: EffortLevel | null = null;
  let resumeSessionId: string | null = null;
  const attachments: string[] = [];
  const disabledTools: string[] = [];
  let hasSandbox = false;
  let hasDoubleDash = false;
  let hasDashPrompt = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-") {
      hasDashPrompt = true;
    } else if (arg === "--") {
      hasDoubleDash = true;
    } else if (arg === "--sandbox") {
      hasSandbox = true;
    } else if (arg.startsWith("-")) {
      const hasValue = [
        "--model",
        "--resume",
        "--permission-mode",
        "--output-format",
        "--input-format",
        "--settings",
        "--effort",
        "--log-file",
        "-i",
        "--conversation",
        "--print-timeout",
        "-c",
        "--config",
        "--disable",
      ].includes(arg);

      if (arg === "--conversation") {
        conversationId = args[i + 1] ?? null;
        i++;
      } else if (arg === "--log-file") {
        logFile = args[i + 1] ?? null;
        i++;
      } else if (arg === "--print-timeout") {
        printTimeout = args[i + 1] ?? null;
        i++;
      } else if (arg === "--model") {
        model = args[i + 1] ?? null;
        i++;
      } else if (arg === "--effort") {
        effort = args[i + 1] as EffortLevel ?? null;
        i++;
      } else if (arg === "--resume") {
        resumeSessionId = args[i + 1] ?? null;
        i++;
      } else if (arg === "-i") {
        const att = args[i + 1];
        if (att) attachments.push(att);
        i++;
      } else if (arg === "--disable") {
        const tool = args[i + 1];
        if (tool) disabledTools.push(tool);
        i++;
      } else if (hasValue) {
        i++;
      }
    } else {
      if (isCodex && arg === "exec") {
        // skip
      } else if (isCodex && arg === "resume") {
        resumeSessionId = args[i + 1] ?? null;
        i++;
      } else {
        prompt = arg;
      }
    }
  }

  if (hasDashPrompt && !prompt) {
    prompt = "-";
  }

  let hasPermissionBypass = false;
  let hasJsonOutput = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dangerously-skip-permissions") {
      hasPermissionBypass = true;
    }
    if (args[i] === "--dangerously-bypass-approvals-and-sandbox") {
      hasPermissionBypass = true;
    }
    if (args[i] === "--permission-mode" && args[i + 1] === "acceptEdits") {
      hasPermissionBypass = true;
    }
    if (args[i] === "--json") {
      hasJsonOutput = true;
    }
    if (args[i] === "--output-format" && args[i + 1] === "json") {
      hasJsonOutput = true;
    }
    if (args[i] === "--output-format=json") {
      hasJsonOutput = true;
    }
  }

  if (isAgy) {
    const newArgs: string[] = [];
    if (conversationId) {
      newArgs.push("--conversation", conversationId);
    }
    if (hasPermissionBypass) {
      newArgs.push("--dangerously-skip-permissions");
    }
    if (logFile) {
      newArgs.push("--log-file", logFile);
    }
    if (hasSandbox) {
      newArgs.push("--sandbox");
    }
    if (printTimeout) {
      newArgs.push("--print-timeout", printTimeout);
    }
    newArgs.push("--print", prompt);
    return newArgs;
  }

  if (isCodex) {
    const newArgs: string[] = ["exec"];
    if (!effort) {
      for (let i = 0; i < args.length - 1; i += 1) {
        if ((args[i] === "-c" || args[i] === "--config") && args[i + 1]?.startsWith("model_reasoning_effort=")) {
          effort = args[i + 1].split("=", 2)[1]?.replace(/^"|"$/g, "") as EffortLevel;
          break;
        }
      }
    }
    if (resumeSessionId) {
      newArgs.push("resume", resumeSessionId);
    }
    if (effort) {
      newArgs.push("-c", `model_reasoning_effort="${effort}"`);
    }
    if (model) {
      newArgs.push("--model", model);
    }
    for (const tool of disabledTools) {
      newArgs.push("--disable", tool);
    }
    if (hasPermissionBypass) {
      newArgs.push("--dangerously-bypass-approvals-and-sandbox");
    }
    newArgs.push("--skip-git-repo-check");
    if (hasJsonOutput) {
      newArgs.push("--json");
    }
    if (attachments.length > 0) {
      for (const att of attachments) {
        newArgs.push("-i", att);
      }
      newArgs.push("--", "-");
    } else {
      newArgs.push(prompt);
    }
    return newArgs;
  }

  return args;
}
