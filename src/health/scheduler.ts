import type { HealthPlugin, HealthConfig, HealthReport } from "./types.js";
import { formatReport } from "./reporter.js";
import { generateSuggestion } from "./suggest.js";

type SuggestFn = (
  report: HealthReport,
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<string | null>;

export class HealthScheduler {
  private plugins: HealthPlugin[];
  private config: HealthConfig;
  private sendReport: (text: string) => Promise<void>;
  private suggestFn: SuggestFn;
  private timers: NodeJS.Timeout[] = [];

  constructor(options: {
    plugins: HealthPlugin[];
    config: HealthConfig;
    sendReport: (text: string) => Promise<void>;
    _suggestFn?: SuggestFn;
  }) {
    this.plugins = options.plugins;
    this.config = options.config;
    this.sendReport = options.sendReport;
    this.suggestFn = options._suggestFn ?? generateSuggestion;
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
    await this.sendReport(formatReport(report));

    if (
      this.config.autonomy !== "report" &&
      report.status !== "green" &&
      this.config.claudeCommand
    ) {
      const suggestion = await this.suggestFn(
        report,
        this.config.claudeCommand,
        this.config.claudeArgs ?? ["--print"],
        120_000,
      );
      if (suggestion) {
        await this.sendReport(`💡 *Suggested actions:*\n\n${suggestion}`);
      }
    }
  }
}
