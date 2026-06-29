import { execFileSync } from "node:child_process";
import type { HealthReport } from "./types.js";

export interface AutoRemediateOptions {
  upgradeScript: string;
  sendNotification: (text: string) => Promise<void>;
}

export async function autoUpdateClis(
  report: HealthReport,
  options: AutoRemediateOptions,
): Promise<void> {
  if (report.pluginName !== "agent-bridge") return;

  const needsUpdate = report.checks.filter(
    c => c.name.startsWith("cli-update-") && c.status !== "green"
  );
  if (needsUpdate.length === 0) return;

  try {
    const output = execFileSync("bash", [options.upgradeScript, "--clis-only"], {
      encoding: "utf8",
      timeout: 120_000,
    });

    const updated = output
      .split("\n")
      .filter(l => l.startsWith("updated:"))
      .map(l => l.slice("updated:".length).trim());

    if (updated.length > 0) {
      await options.sendNotification(
        `🔄 *CLI auto-updated:*\n${updated.map(u => `• ${u}`).join("\n")}`
      );
    }
  } catch (err) {
    await options.sendNotification(
      `⚠️ *CLI auto-update failed:* ${(err as Error).message.slice(0, 300)}`
    );
  }
}
