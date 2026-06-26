/**
 * PURPOSE: Worker job CLI routing policy.
 * Separates code-writing chains from low-risk scribe/read-only chains so Agy
 * can save coding-model tokens without owning production edits.
 * NEIGHBORS: src/index-worker.ts, src/workerDispatch.ts
 */

export type WorkerCliKind = "codex" | "claude" | "antigravity";

const VALID_WORKER_CLIS = new Set<WorkerCliKind>(["codex", "claude", "antigravity"]);

function parseCliChain(raw: string | undefined, fallback: WorkerCliKind[]): WorkerCliKind[] {
  const parsed = (raw ?? "")
    .split(",")
    .map(s => s.trim())
    .filter((s): s is WorkerCliKind => VALID_WORKER_CLIS.has(s as WorkerCliKind));
  return parsed.length > 0 ? parsed : fallback;
}

function withoutAntigravity(chain: WorkerCliKind[]): WorkerCliKind[] {
  const codeSafe = chain.filter(cli => cli !== "antigravity");
  return codeSafe.length > 0 ? codeSafe : ["codex", "claude"];
}

export interface WorkerCliPolicy {
  interactiveChain: WorkerCliKind[];
  codeChain: WorkerCliKind[];
  scribeChain: WorkerCliKind[];
}

export function resolveWorkerCliPolicy(env: NodeJS.ProcessEnv = process.env): WorkerCliPolicy {
  const interactiveChain = parseCliChain(env.WORKER_CLI_CHAIN, ["codex", "claude", "antigravity"]);
  const codeChain = withoutAntigravity(
    parseCliChain(env.WORKER_CODE_CLI_CHAIN, withoutAntigravity(interactiveChain)),
  );
  const scribeChain = parseCliChain(env.WORKER_SCRIBE_CLI_CHAIN, ["antigravity", "codex", "claude"]);

  return { interactiveChain, codeChain, scribeChain };
}

export function isCodeCliAllowed(cli: string | null | undefined): boolean {
  return cli === "codex" || cli === "claude";
}
