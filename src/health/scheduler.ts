import type { HealthPlugin, HealthConfig } from "./types.js";
import { formatReport } from "./reporter.js";

export class HealthScheduler {
  private plugins: HealthPlugin[];
  private config: HealthConfig;
  private sendReport: (text: string) => Promise<void>;
  private timers: NodeJS.Timeout[] = [];

  constructor(options: {
    plugins: HealthPlugin[];
    config: HealthConfig;
    sendReport: (text: string) => Promise<void>;
  }) {
    this.plugins = options.plugins;
    this.config = options.config;
    this.sendReport = options.sendReport;
  }

  start(): void {
    if (!this.config.enabled) return;
    for (const plugin of this.plugins) {
      const timer = setInterval(() => {
        this.runPlugin(plugin).catch(err =>
          console.error(`[health] plugin ${plugin.name} error`, err)
        );
      }, this.config.cadenceSeconds * 1000);
      this.timers.push(timer);
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  async runPlugin(plugin: HealthPlugin): Promise<void> {
    const report = await plugin.check();
    const text = formatReport(report);
    await this.sendReport(text);
  }
}
