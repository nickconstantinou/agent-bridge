import type { HealthReport } from "./types.js";

const EMOJI: Record<string, string> = { green: "✅", amber: "⚠️", red: "🔴" };

export function formatReport(report: HealthReport): string {
  const icon = EMOJI[report.status] ?? "❓";
  const lines: string[] = [
    `${icon} *${report.pluginName}* — ${report.status.toUpperCase()}`,
    `_${report.summary}_`,
    "",
  ];
  for (const check of report.checks) {
    const ci = EMOJI[check.status] ?? "❓";
    const val = check.value !== undefined ? ` (${check.value})` : "";
    lines.push(`${ci} ${check.name}: ${check.message}${val}`);
  }
  lines.push("", `_${report.timestamp}_`);
  return lines.join("\n");
}
