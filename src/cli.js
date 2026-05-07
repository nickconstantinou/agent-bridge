import { spawn } from "node:child_process";
import { getBotProjectDir, getCliWorkingDir } from "./bridge.js";

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
  return { ok: errors.length === 0, errors };
}

export function parseCliResult({ bot, stdout }) {
  return bot === "codex" ? parseCodexResult(stdout) : parseGeminiResult(stdout);
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

  for (const line of stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
    try {
      const event = JSON.parse(line);
      sessionId ??= event.thread_id ?? event.threadId ?? null;
      const parts = event.message?.content;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (part?.type === "output_text" && typeof part.text === "string") {
            appendText(part.text);
          }
        }
      }
      appendText(event.text);
      appendText(event.message?.text);
      appendText(event.item?.text);
    } catch {
      appendText(line);
    }
  }

  return { text: text.trim() || "(no output)", sessionId };
}

function parseGeminiResult(stdout) {
  const cleaned = stdout.replace(/^Error:\s*/i, "").trim();
  const candidates = [];

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const line of cleaned.split("\n").map((value) => value.trim()).filter(Boolean)) {
    candidates.push(line);
  }

  let parsed = null;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      continue;
    }
  }

  if (!parsed) throw new Error(stdout.trim() || "Gemini returned no parseable output");
  return {
    text: String(parsed.response ?? parsed.text ?? parsed.message ?? "").trim() || "(no output)",
    sessionId: parsed.session_id ?? parsed.sessionId ?? null,
  };
}

export function runCli(command, args, cwd, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120000;
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
      }, 1000).unref?.();
      reject(new Error(`CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      finished = true;
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      if (stdout.trim()) return resolve(stdout);
      reject(new Error(stderr.trim() || `CLI exited with code ${code}`));
    });
  });
}
