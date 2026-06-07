/**
 * PURPOSE: Worker bot — autonomous job queue control surface.
 * Handles /jobs, /issues, /review commands. Queues work items when the schema
 * is available (Phase 1+). Phase 0: acknowledgement stubs only.
 * NEIGHBORS: src/index-worker.ts, src/db.ts
 */

export interface WorkerCommandContext {
  workerEnabled: boolean;
}

export interface WorkerMessageResult {
  kind: "message";
  text: string;
}

export type WorkerCommandResult = WorkerMessageResult;

const WORKER_COMMANDS = new Set(["/jobs", "/issues", "/review"]);

export function buildWorkerCommands(): Array<{ command: string; description: string }> {
  return [
    { command: "jobs",   description: "List active and pending jobs" },
    { command: "issues", description: "List proposed work items" },
    { command: "review", description: "Trigger a defect scan: /review [repo]" },
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
