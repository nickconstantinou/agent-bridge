import type { HealthReport } from "./types.js";

const EMOJI: Record<string, string> = { green: "✅", amber: "⚠️", red: "🔴" };

function formatTimestamp(ts: string): string {
  // Normalize ISO format (e.g. 2026-06-03T18:53:15.634839) to a cleaner readable format
  const match = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (match) {
    const [, year, month, day, hours, minutes, seconds] = match;
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
  }
  return ts;
}

export function formatReport(report: HealthReport): string {
  const icon = EMOJI[report.status] ?? "❓";
  const statusStr = report.status.toUpperCase();
  const header = `📡 *[${report.pluginName}]* ── ${icon} *${statusStr}*`;
  const divider = "━━━━━━━━━━━━━━━━━━━━━━";
  
  const lines: string[] = [
    header,
    `_${report.summary}_`,
    divider,
  ];

  if (report.checks.length > 0) {
    const checkLines: string[] = [];
    for (const check of report.checks) {
      const ci = EMOJI[check.status] ?? "❓";
      const val = check.value !== undefined ? ` (${check.value})` : "";
      checkLines.push(`${ci}  ${check.name}: ${check.message}${val}`);
    }
    lines.push("```");
    lines.push(...checkLines);
    lines.push("```");
  }

  lines.push(`⏱️ _${formatTimestamp(report.timestamp)}_`);
  return lines.join("\n");
}

