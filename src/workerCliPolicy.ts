/**
 * PURPOSE: Worker job CLI routing policy.
 * Separates code-writing chains from low-risk scribe/read-only chains so Agy
 * can save coding-model tokens without owning production edits.
 * NEIGHBORS: src/index-worker.ts, src/workerDispatch.ts
 */

import { parseCliChain as parseSharedCliChain, workerChainKinds, codeChainKinds } from "./providers/selection.js";

export type WorkerCliKind = "codex" | "claude" | "antigravity";

function parseCliChain(raw: string | undefined, fallback: WorkerCliKind[]): WorkerCliKind[] {
  return parseSharedCliChain(raw, {
    allowed: workerChainKinds() as WorkerCliKind[],
    fallback,
  });
}

function withoutAntigravity(chain: WorkerCliKind[]): WorkerCliKind[] {
  const codeKinds = new Set<string>(codeChainKinds());
  const codeSafe = chain.filter(cli => codeKinds.has(cli));
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
