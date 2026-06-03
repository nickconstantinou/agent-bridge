import { spawn } from "node:child_process";
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
    const result = await new Promise<{ stdout: string; stderr: string; status: number | null; error: Error | null }>(
      (resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(this.command, this.args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (err) {
          resolve({ stdout: "", stderr: "", status: null, error: err instanceof Error ? err : new Error(String(err)) });
          return;
        }

        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          try { child.kill(); } catch { /* ignore */ }
          resolve({ stdout, stderr, status: null, error: new Error(`timeout after ${this.timeoutMs}ms`) });
        }, this.timeoutMs);

        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, status: code, error: null });
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, status: null, error: err });
        });
      }
    );

    if (result.error || result.status !== 0) {
      const message = result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`);
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
