/**
 * PURPOSE: Single authoritative child-process lifecycle for CLI execution —
 * spawning, environment scrubbing, the process registry, timers, event
 * emission, cancellation/termination, and close/error settlement.
 * INPUTS: Command/args/cwd plus CliOptions.
 * OUTPUTS: A settled { stdout } outcome; runCli/runCliAsync in src/cli.ts are
 * thin adapters that call runSupervisedProcess() and reshape its return value.
 * NEIGHBORS: src/cli.ts, src/workspaceLock.ts, src/db.ts
 * LOGIC: Issue #135 Phase 2 — replaces what were previously two independently
 * duplicated implementations (runCli, runCliAsync) with one internal runner.
 * Preserves the exact public contracts of runCli()/runCliAsync() and every
 * cancellation/timeout/registry guarantee they previously provided.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { CliOptions } from "./types.js";
import { type as evtType } from "./events/types.js";
import type { BridgeEvent } from "./events/types.js";
import type { EffortLevel } from "./effort.js";
import type { ExecutionLaneHandle } from "./db.js";
import { buildWorkspaceLockedInvocation } from "./workspaceLock.js";

interface ActiveExecution {
  child: ChildProcess | null;
  lifecycleToken: string | null;
  lifecycleHandle: ExecutionLaneHandle | null;
  lifecycleDone: Promise<void> | null;
  finishLifecycle: (() => void) | null;
}

// The single process registry. Both runCli() and runCliAsync() route through
// runSupervisedProcess() below, which is the only code that reads or writes
// this map — there is no second registry.
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

const KILL_GRACE_MS = 5_000;
const ANTIGRAVITY_STALLED_PLANNER_MARKER = "PlannerResponse without ModifiedResponse encountered";

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

/**
 * The single authoritative child-process lifecycle. runCli() and
 * runCliAsync() in src/cli.ts are thin adapters over this function; both
 * share identical spawn/env/timer/registry/cancellation/settlement behaviour.
 */
export async function runSupervisedProcess(command: string, args: string[], cwd: string, options: CliOptions = {}): Promise<{ stdout: string }> {
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

  return new Promise((resolve, reject) => {
    const normalizedArgs = normalizeCliArgs(command, args);
    const spawnInvocation = buildWorkspaceLockedInvocation(command, normalizedArgs, cwd);
    console.log(formatSpawnLog(command, normalizedArgs, cwd, options.chatId, options.stdin));
    // detached:true puts the child in its own process group so timeout kills
    // can signal the whole subtree (process.kill(-pid)) instead of stranding
    // grandchildren.
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

    const doResolve = (val: { stdout: string }) => {
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
        doResolve({ stdout });
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
        doResolve({ stdout });
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
