import { spawn } from "node:child_process";
import type { HealthReport } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

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

export async function generateSuggestion(
  report: HealthReport,
  claudeCommand: string,
  claudeArgs: string[] = ["--print"],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  const prompt = buildSuggestionPrompt(report);
  const args = [...claudeArgs, prompt];

  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(claudeCommand, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }

    const chunks: Buffer[] = [];
    const killTimer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);

    proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      resolve(code === 0 ? Buffer.concat(chunks).toString("utf8").trim() : null);
    });
    proc.on("error", () => {
      clearTimeout(killTimer);
      resolve(null);
    });
  });
}
