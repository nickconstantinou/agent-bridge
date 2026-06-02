import { spawnSync } from "node:child_process";
import type { HealthPlugin, HealthReport } from "../types.js";

export class ExternalPlugin implements HealthPlugin {
  name: string;
  private command: string;
  private args: string[];
  private timeoutMs: number;

  constructor(options: { name: string; command: string; args?: string[]; timeoutMs?: number }) {
    this.name = options.name;
    this.command = options.command;
    this.args = options.args ?? [];
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async check(): Promise<HealthReport> {
    const result = spawnSync(this.command, this.args, {
      timeout: this.timeoutMs,
      encoding: "utf8",
    });

    if (result.error || result.status !== 0) {
      const message = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
      return {
        pluginName: this.name,
        status: "red",
        checks: [{ name: "script", status: "red", message }],
        summary: `Health check script failed: ${message}`,
        timestamp: new Date().toISOString(),
      };
    }

    try {
      return JSON.parse(result.stdout) as HealthReport;
    } catch {
      const preview = result.stdout.slice(0, 200);
      return {
        pluginName: this.name,
        status: "red",
        checks: [{ name: "parse", status: "red", message: `Invalid JSON output: ${preview}` }],
        summary: "Health check script output was not valid JSON",
        timestamp: new Date().toISOString(),
      };
    }
  }
}
