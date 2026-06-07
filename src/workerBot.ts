/**
 * PURPOSE: Worker bot — autonomous job queue control surface.
 * Handles /jobs, /issues, /review commands. Queues work items when the schema
 * is available (Phase 1+). Phase 0: acknowledgement stubs only.
 * NEIGHBORS: src/index-worker.ts, src/db.ts
 */

const DEFAULT_CLI_CHAIN = ["codex", "claude", "antigravity"];

export interface WorkerCommandContext {
  workerEnabled: boolean;
  cliChain?: string[];
}

export interface WorkerMessageResult {
  kind: "message";
  text: string;
}

export interface WorkerKeyboardMessageResult {
  kind: "keyboard_message";
  text: string;
  reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
}

export type WorkerCommandResult = WorkerMessageResult | WorkerKeyboardMessageResult;

const WORKER_COMMANDS = new Set(["/jobs", "/issues", "/review", "/models"]);

export function buildWorkerCommands(): Array<{ command: string; description: string }> {
  return [
    { command: "jobs",   description: "List active and pending jobs" },
    { command: "issues", description: "List proposed work items" },
    { command: "review", description: "Trigger a defect scan: /review [repo]" },
    { command: "models", description: "Show CLI execution chain" },
  ];
}

function normalizeCommand(text: string): string {
  return text.trim().toLowerCase().split(/\s+/)[0].replace(/@\S+$/, "");
}

export function isWorkerCommand(text: string): boolean {
  const cmd = normalizeCommand(text);
  if (WORKER_COMMANDS.has(cmd)) return true;
  // /review with a repo arg
  if (text.trim().toLowerCase().startsWith("/review ")) return true;
  return false;
}

export function handleWorkerCommand(
  text: string,
  ctx: WorkerCommandContext,
): WorkerCommandResult | null {
  const trimmed = text.trim();
  const cmd = normalizeCommand(trimmed);

  if (cmd === "/jobs") {
    if (!ctx.workerEnabled) {
      return { kind: "message", text: "No jobs — worker is not yet active (WORKER_ENABLED=false).\nEnable it once Phase 1 schema is deployed." };
    }
    return { kind: "message", text: "No jobs queued." };
  }

  if (cmd === "/issues") {
    if (!ctx.workerEnabled) {
      return { kind: "message", text: "No issues — worker is not yet active (WORKER_ENABLED=false).\nEnable it once Phase 1 schema is deployed." };
    }
    return { kind: "message", text: "No work items yet." };
  }

  if (cmd === "/models") {
    const chain = ctx.cliChain ?? DEFAULT_CLI_CHAIN;
    return {
      kind: "keyboard_message",
      text: `[worker CLI chain]\n\nExecution order: ${chain.join(" → ")}\n\nOn failure, the next CLI in the chain is tried. Merge approval always requires your explicit confirmation.`,
      reply_markup: {
        inline_keyboard: chain.map((cli) => [{ text: cli, callback_data: `worker:cli:${cli}` }]),
      },
    };
  }

  if (cmd === "/review") {
    const parts = trimmed.split(/\s+/);
    const repo = parts.slice(1).join(" ").trim() || null;
    const repoNote = repo ? ` for **${repo}**` : "";

    if (!ctx.workerEnabled) {
      return {
        kind: "message",
        text: `Review request${repoNote} received — worker is not yet active (WORKER_ENABLED=false).\nEnable it once Phase 1 schema is deployed.`,
      };
    }
    return {
      kind: "message",
      text: `Defect scan queued${repoNote}. Use /jobs to check progress.`,
    };
  }

  return null;
}
