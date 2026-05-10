import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import { getBotProjectDir, getCliWorkingDir } from "./bridge.js";

export function buildExecutionOptions(value = "safe") {
  const executionMode = value || "safe";
  if (executionMode !== "safe" && executionMode !== "trusted") {
    throw new Error("BRIDGE_EXECUTION_MODE must be either safe or trusted");
  }
  return { executionMode };
}

export function buildCliInvocation({ bot, prompt, sessionId, command, model, executionMode = "safe", outputFormat = null }) {
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
    const useAcp = process.env.GEMINI_ACP === "1" && !outputFormat;
    const resolvedOutputFormat =
      outputFormat || (process.env.GEMINI_STREAM_JSON === "1" ? "stream-json" : "json");
    return {
      command,
      args: [
        "--skip-trust",
        "--approval-mode",
        approvalMode,
        "--include-directories",
        projectDir,
        ...modelArg,
        ...resumeArg,
        ...(useAcp ? ["--acp"] : ["--output-format", resolvedOutputFormat]),
        "-p",
        prompt,
      ],
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

  if (process.env.GEMINI_ACP === "1") {
    return parseGeminiAcpResult(cleaned);
  }

  const streamResult = parseGeminiStreamJson(cleaned);
  if (streamResult) return streamResult;

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
  const warnings = [
    "Warning: True color",
    "YOLO mode is enabled",
    "Ripgrep is not available",
    "Falling back to GrepTool"
  ];
  const lines = cleaned.split("\n").filter(l => {
    const trimmed = l.trim();
    return !trimmed.startsWith("Error:") && !warnings.some(w => trimmed.startsWith(w));
  });
  if (lines.length > 0) {
    return { text: lines.join("\n").trim(), sessionId: null };
  }

  throw new Error(`Gemini returned no parseable output: ${cleaned.slice(0, 100)}`);
}

function parseGeminiAcpResult(stdout) {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error("Gemini ACP returned empty output");
  }

  const lastLine = lines[lines.length - 1];
  try {
    const parsed = JSON.parse(lastLine);
    const text = String(parsed.response ?? parsed.text ?? parsed.message ?? "").trim();
    if (!text) throw new Error("Gemini ACP returned no assistant text");
    return { text, sessionId: parsed.session_id ?? parsed.sessionId ?? null };
  } catch {
    if (lastLine.startsWith("{") || lastLine.startsWith("[")) {
      throw new Error("Gemini ACP output was not parseable");
    }
    return { text: lastLine, sessionId: null };
  }
}

function parseGeminiStreamJson(stdout) {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  let sessionId = null;
  let text = "";
  let sawJson = false;

  const appendText = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    text += (text ? "\n" : "") + trimmed;
  };

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      sawJson = true;
      sessionId = sessionId || event.session_id || event.sessionId || event.thread_id || event.threadId || null;

      if (event.message?.content && Array.isArray(event.message.content)) {
        for (const part of event.message.content) {
          if ((part.type === "output_text" || part.type === "text") && part.text) {
            appendText(part.text);
          }
        }
        continue;
      }

      appendText(event.response ?? event.text ?? event.message?.text ?? event.item?.text ?? "");
    } catch {
      return null;
    }
  }

  if (!sawJson || (!text.trim() && !sessionId)) return null;
  return { text: text.trim() || "(no output)", sessionId };
}

export function runCli(command, args, cwd, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120000;
  const idleTimeoutMs = options.idleTimeoutMs ?? null;
  const killGraceMs = options.killGraceMs ?? 5000;
  const markCliError = (error) => {
    error.isCliError = true;
    return error;
  };
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], cwd, detached: true });
		let stdout = "";
		let stderr = "";
		let finished = false;
		let settled = false;
		let idleTimer = null;
		let killTimer = null;

		const killChildTree = () => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				try { child.kill("SIGTERM"); } catch {}
			}
			killTimer = setTimeout(() => {
				if (finished) return;
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					try { child.kill("SIGKILL"); } catch {}
				}
			}, killGraceMs);
			killTimer.unref?.();
		};

		const settleReject = (error) => {
			if (settled) return;
			settled = true;
			reject(markCliError(error));
		};

		const settleResolve = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};

    const clearIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };

		const scheduleIdleTimeout = () => {
			if (!idleTimeoutMs || finished) return;
			clearIdleTimer();
			idleTimer = setTimeout(() => {
				if (finished) return;
				killChildTree();
				settleReject(new Error(`CLI idle timeout after ${idleTimeoutMs}ms`));
			}, idleTimeoutMs);
			idleTimer.unref?.();
		};

		const timer = setTimeout(() => {
			if (finished) return;
			killChildTree();
			settleReject(new Error(`CLI timed out after ${timeoutMs}ms`));
		}, timeoutMs);
    timer.unref?.();
    scheduleIdleTimeout();

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      scheduleIdleTimeout();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      scheduleIdleTimeout();
    });

		child.on("error", (error) => {
			clearIdleTimer();
			settleReject(error);
		});
		child.on("close", (code) => {
			finished = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			clearIdleTimer();
			if (code === 0) return settleResolve(stdout);
			if (stdout.trim()) return settleResolve(stdout);
			settleReject(new Error(stderr.trim() || `CLI exited with code ${code}`));
		});
	});
}

/**
 * Async CLI runner with progress callbacks and cancellation support.
 * @param command - Command to run
 * @param args - Command arguments
 * @param cwd - Working directory
 * @param options - Options including onProgress and onCancel callbacks
 */
export async function runCliAsync(command, args, cwd, options = {}) {
	const timeoutMs = options.timeoutMs ?? 120000;
	const idleTimeoutMs = options.idleTimeoutMs ?? null;
	const killGraceMs = options.killGraceMs ?? 5000;
	const onProgress = options.onProgress ?? (() => {});
	const onCancel = options.onCancel ?? (() => {});

	let stdout = "";
	let stderr = "";
	let finished = false;
	let settled = false;
	let idleTimer = null;
	let killTimer = null;
	let timer = null;
	let child = null;

	const killChildTree = () => {
		if (!child?.pid) return;
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			try { child.kill("SIGTERM"); } catch {}
		}
		killTimer = setTimeout(() => {
			if (finished) return;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				try { child.kill("SIGKILL"); } catch {}
			}
		}, killGraceMs);
		killTimer.unref?.();
	};

	const clearIdleTimer = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = null;
	};

	const scheduleIdleTimeout = () => {
		if (!idleTimeoutMs || finished) return;
		clearIdleTimer();
		idleTimer = setTimeout(() => {
			if (finished) return;
			killChildTree();
			settled = true;
			reject(new Error(`CLI idle timeout after ${idleTimeoutMs}ms`));
		}, idleTimeoutMs);
		idleTimer.unref?.();
	};

	return new Promise((resolve, reject) => {
		// Spawn in a new process group for clean kill of the entire tree
		child = spawn(command, args, { 
			stdio: ["ignore", "pipe", "pipe"], 
			cwd, 
			detached: true,
			shell: false,
		});

		const killFn = () => {
			if (settled) return;
			finished = true;
			killChildTree();
			reject(new Error("CLI cancelled"));
		};

		// Provide cancel function to caller
		onCancel(killFn);

		timer = setTimeout(() => {
			if (finished) return;
			killChildTree();
			settled = true;
			reject(new Error(`CLI timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref?.();
		scheduleIdleTimeout();

		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			stdout += text;
			scheduleIdleTimeout();
			try {
				onProgress(text);
			} catch { /* ignore progress errors */ }
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
			scheduleIdleTimeout();
		});

		child.on("error", (error) => {
			clearIdleTimer();
			settled = true;
			reject(error);
		});

		child.on("close", (code) => {
			finished = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			clearIdleTimer();
			if (settled) return;
			settled = true;

			if (code === 0) {
				resolve({ text: stdout.trim(), sessionId: null });
			} else if (stdout.trim()) {
				resolve({ text: stdout.trim(), sessionId: null });
			} else {
				reject(new Error(stderr.trim() || `CLI exited with code ${code}`));
			}
		});
	});
}
