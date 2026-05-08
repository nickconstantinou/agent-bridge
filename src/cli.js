import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import { getBotProjectDir, getCliWorkingDir } from "./bridge.js";
import { createStreamingLineParser } from "./streaming.js";

export function buildExecutionOptions(value = "safe") {
  const executionMode = value || "safe";
  if (executionMode !== "safe" && executionMode !== "trusted") {
    throw new Error("BRIDGE_EXECUTION_MODE must be either safe or trusted");
  }
  return { executionMode };
}

export function buildCliInvocation({ bot, prompt, sessionId, command, model, executionMode = "safe" }) {
  const { executionMode: mode } = buildExecutionOptions(executionMode);
  const projectDir = getBotProjectDir(bot);

  if (bot === "codex") {
    const trustArg = [
      "-c",
      `projects."${projectDir}".trust_level="trusted"`,
    ];
    const modelArg = model ? ["-m", model] : [];
    const sandboxArg = mode === "trusted" ? ["--dangerously-bypass-approvals-and-sandbox"] : [];

    return sessionId
      ? { command, args: ["exec", "--skip-git-repo-check", ...sandboxArg, ...trustArg, ...modelArg, "-C", projectDir, "resume", sessionId, prompt] }
      : { command, args: ["exec", "--skip-git-repo-check", ...sandboxArg, ...trustArg, ...modelArg, "-C", projectDir, "--json", prompt] };
  }

  if (bot === "gemini") {
    const modelArg = model ? ["--model", model] : [];
    const resumeArg = sessionId ? ["--resume", sessionId] : [];
    const approvalMode = mode === "trusted" ? "yolo" : "plan";
    return {
      command,
      args: ["--skip-trust", "--approval-mode", approvalMode, "--include-directories", projectDir, ...modelArg, ...resumeArg, "--output-format", "json", "-p", prompt],
    };
  }

  throw new Error(`Unsupported bot: ${bot}`);
}

export function buildGeminiFallbackInvocation({ command, model, prompt }) {
  const modelArg = model ? ["--model", model] : [];
  return {
    command,
    args: [
      "--skip-trust",
      "--approval-mode",
      "plan",
      "--include-directories",
      getBotProjectDir("gemini"),
      ...modelArg,
      "--output-format",
      "json",
      "-p",
      `${prompt}\n\nDo not use tools. Answer from inspection and reasoning only. If a tool would be required, say exactly what is blocked.`,
    ],
  };
}

export function validateBridgeConfig(config) {
  const errors = [];
  if (!config?.allowedUserId) errors.push("TELEGRAM_ALLOWED_USER_ID is required");
  const pollIntervalMs = Number(config?.pollIntervalMs);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) errors.push("POLL_INTERVAL_MS must be a positive number");
  try {
    buildExecutionOptions(config?.executionMode);
  } catch (error) {
    errors.push(error.message);
  }
  let enabledBotCount = 0;
  for (const [kind, bot] of Object.entries(config?.bots || {})) {
    if (!bot?.token) continue;
    enabledBotCount += 1;
    if (!bot?.command) errors.push(`${kind.toUpperCase()}_COMMAND is required`);
  }
  if (enabledBotCount === 0) errors.push("At least one Telegram bot token is required");

  if (config?.serviceKind) {
    const activeKind = config.serviceKind;
    for (const kind of Object.keys(config?.bots || {})) {
      if (kind !== activeKind && config.bots?.[kind]?.token) {
        errors.push(`BRIDGE_ENV_FILE for ${activeKind} must not load ${kind.toUpperCase()}_TOKEN`);
      }
    }
    const activeBot = config.bots?.[activeKind];
    if (!activeBot?.token) {
      errors.push(`BRIDGE_ENV_FILE for ${activeKind} must load ${activeKind.toUpperCase()}_TOKEN`);
    }
    if (activeKind === "gemini" && activeBot?.command) {
      if (!activeBot.command.startsWith("/")) {
        errors.push("GEMINI_COMMAND must be an absolute path in the Gemini service");
      } else {
        try {
          accessSync(activeBot.command, constants.X_OK);
        } catch {
          errors.push(`GEMINI_COMMAND is not executable or does not exist: ${activeBot.command}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function parseCliResult({ bot, stdout }) {
  return bot === "codex" ? parseCodexResult(stdout) : parseGeminiResult(stdout);
}

export function createCliStreamingParser({ bot, onUpdate }) {
  if (bot === "codex") {
    return createStreamingLineParser({
      onRecord(line) {
        try {
          const event = JSON.parse(line);
          const text = extractTextFromEvent(event);
          if (text) onUpdate(text, event.thread_id || event.threadId || event.sessionId || null);
        } catch {
          onUpdate(line, null);
        }
      },
    });
  }

  if (bot === "gemini") {
    return createStreamingLineParser({
      onRecord(line) {
        try {
          const parsed = JSON.parse(line);
          const text = String(parsed.response ?? parsed.text ?? parsed.message ?? "").trim();
          if (text) onUpdate(text, parsed.session_id ?? parsed.sessionId ?? null);
        } catch {
          onUpdate(line, null);
        }
      },
    });
  }

  throw new Error(`Unsupported bot: ${bot}`);
}

function extractTextFromEvent(event) {
  if (event.message?.content && Array.isArray(event.message.content)) {
    return event.message.content
      .filter((part) => (part.type === "output_text" || part.type === "text") && part.text)
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return String(event.text ?? event.message?.text ?? event.item?.text ?? "").trim();
}

function parseCodexResult(stdout) {
  let sessionId = null;
  let text = "";

  const appendText = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    text += (text ? "\n" : "") + trimmed;
  };

  const lines = stdout.split("\n").map((v) => v.trim()).filter(Boolean);
  
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      
      // Extract session ID
      sessionId = sessionId || event.thread_id || event.threadId || event.sessionId || null;
      
      // Extract content from various possible event structures
      if (event.message?.content && Array.isArray(event.message.content)) {
        for (const part of event.message.content) {
          if ((part.type === "output_text" || part.type === "text") && part.text) {
            appendText(part.text);
          }
        }
      } else if (event.text) {
        appendText(event.text);
      } else if (event.message?.text) {
        appendText(event.message.text);
      } else if (event.item?.text) {
        appendText(event.item.text);
      }
    } catch {
      appendText(line);
    }
  }

  return { text: text.trim() || "(no output)", sessionId };
}

function parseGeminiResult(stdout) {
  const cleaned = stdout.trim();
  if (!cleaned) throw new Error("Gemini returned empty output");

  // Try to find any JSON-like structure in the output
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        text: String(parsed.response ?? parsed.text ?? parsed.message ?? "").trim() || "(no output)",
        sessionId: parsed.session_id ?? parsed.sessionId ?? null,
      };
    } catch {
      // Ignore and fallback
    }
  }

  // Fallback: if no JSON found or parsing failed, check if it's just plain text
  // but usually we expect JSON from Gemini with --output-format json
  const lines = cleaned.split("\n").filter(l => !l.startsWith("Error:"));
  if (lines.length > 0) {
    return { text: lines.join("\n").trim(), sessionId: null };
  }

  throw new Error(`Gemini returned no parseable output: ${cleaned.slice(0, 100)}`);
}

export function runCli(command, args, cwd, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120000;
  const killGraceMs = options.killGraceMs ?? 5000;
  const onStdoutChunk = options.onStdoutChunk || null;
  const onStderrChunk = options.onStderrChunk || null;
  const markCliError = (error) => {
    error.isCliError = true;
    return error;
  };
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], cwd });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, killGraceMs).unref?.();
      reject(markCliError(new Error(`CLI timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      onStdoutChunk?.(String(chunk));
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      onStderrChunk?.(String(chunk));
    });

    child.on("error", (error) => reject(markCliError(error)));
    child.on("close", (code) => {
      finished = true;
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      if (stdout.trim()) return resolve(stdout);
      reject(markCliError(new Error(stderr.trim() || `CLI exited with code ${code}`)));
    });
  });
}
