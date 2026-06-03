import { buildCliInvocation, runCli, parseCliResult } from "../cli.js";
import type { HealthReport } from "./types.js";
import type { BotKind } from "../types.js";

const SUGGEST_TIMEOUT_MS = 600_000;

export function buildSuggestionPrompt(report: HealthReport): string {
  const failing = report.checks.filter(c => c.status !== "green");
  const lines = failing.map(c => `- ${c.name} (${c.status}): ${c.message}`).join("\n");
  return [
    `Health check for ${report.pluginName} returned ${report.status.toUpperCase()}.`,
    `Summary: ${report.summary}`,
    "",
    "Failing checks:",
    lines || "- (none individually flagged)",
    "",
    "What are the most likely causes and the exact commands or steps to resolve each issue? Be concise.",
  ].join("\n");
}

export function buildSuggestionInvocation(
  bot: BotKind,
  botConfig: { command: string; modelPreference: string[] },
  prompt: string,
): { command: string; args: string[] } {
  return buildCliInvocation({
    bot,
    command: botConfig.command,
    model: botConfig.modelPreference[0] ?? null,
    prompt,
    sessionId: null,
    executionMode: "safe",
    outputFormat: bot !== "antigravity" ? "json" : null,
  });
}

export async function generateSuggestion(
  report: HealthReport,
  bot: BotKind,
  botConfig: { command: string; modelPreference: string[] },
): Promise<string | null> {
  const prompt = buildSuggestionPrompt(report);
  const invocation = buildSuggestionInvocation(bot, botConfig, prompt);
  try {
    const stdout = await runCli(invocation.command, invocation.args, process.cwd(), {
      timeoutMs: SUGGEST_TIMEOUT_MS,
    });
    const result = parseCliResult({ bot, stdout, logContent: null });
    return result.text.trim() || null;
  } catch {
    return null;
  }
}
