/**
 * PURPOSE: Job handler for pr_watch task type.
 * Polls each open agent PR via gh cli and:
 *   - Stale (updatedAt > staleHours old): marks state 'stale'
 *   - CI failing: marks state 'ci_failed', enqueues one tdd_implementation fix job per head SHA
 *   - CI passing (not held/stale): marks state 'ready_to_merge', ensures a pending merge approval
 * Never merges, closes, or force-pushes.
 * NEIGHBORS: src/db.ts, src/jobExecutor.ts, src/index-worker.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext, JobHandlerResult } from "../jobExecutor.js";

type RunCommand = (binary: string, args: string[]) => Promise<string>;

interface PrWatchDeps {
  runCommand: RunCommand;
  /** Hours without activity before a PR is considered stale (default 72). */
  staleHours?: number;
}

interface GhPrView {
  headRefOid: string;
  statusCheckRollup: Array<{ __typename: string; conclusion: string; name: string }>;
  mergeable: string;
  updatedAt: string;
}

function isRollupFailing(rollup: GhPrView["statusCheckRollup"]): boolean {
  return rollup.some(c => c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT");
}

function isRollupPassing(rollup: GhPrView["statusCheckRollup"]): boolean {
  return rollup.length > 0 && rollup.every(c => c.conclusion === "SUCCESS");
}

export function createPrWatchHandler(deps: PrWatchDeps): JobHandler {
  const { runCommand, staleHours = 72 } = deps;
  const staleThresholdMs = staleHours * 60 * 60 * 1000;

  return async function prWatchHandler(
    _input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const openPrs = ctx.db.listAllOpenAgentPrs();
    if (openPrs.length === 0) return { summary: "No open agent PRs to watch." };

    const now = Date.now();
    const lines: string[] = [];

    for (const link of openPrs) {
      if (link.pr_state === "held") continue;

      const viewOutput = await runCommand("gh", [
        "pr", "view", String(link.pr_number),
        "--repo", link.repository,
        "--json", "headRefOid,statusCheckRollup,mergeable,updatedAt",
      ]);

      const prData = JSON.parse(viewOutput) as GhPrView;
      const { headRefOid, statusCheckRollup, updatedAt } = prData;

      // Stale check takes priority over CI state
      const updatedAtMs = new Date(updatedAt).getTime();
      if (now - updatedAtMs > staleThresholdMs) {
        ctx.db.updatePrState(link.id, "stale");
        lines.push(`#${link.pr_number} (${link.repository}): marked stale`);
        continue;
      }

      if (isRollupFailing(statusCheckRollup)) {
        ctx.db.updatePrState(link.id, "ci_failed");
        const fixKey = `ci_fix:${link.repository}:${link.pr_number}:${headRefOid}`;
        ctx.db.createWorkJob({
          task_type: "tdd_implementation",
          idempotency_key: fixKey,
          work_item_id: link.work_item_id,
          input_json: {
            work_item_id: link.work_item_id,
            repository: link.repository,
            branch_name: link.branch_name,
            ci_fix: true,
          },
          max_attempts: 1,
        });
        lines.push(`#${link.pr_number} (${link.repository}): CI failing, fix job enqueued`);
      } else if (isRollupPassing(statusCheckRollup)) {
        ctx.db.updatePrState(link.id, "ready_to_merge");

        // Ensure exactly one pending merge approval with the current head SHA
        const existing = ctx.db.raw
          .prepare(
            "SELECT id, payload_json FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr' AND status = 'pending'"
          )
          .get(link.work_item_id) as { id: number; payload_json: string } | undefined;

        if (existing) {
          const payload = JSON.parse(existing.payload_json);
          payload.head_sha = headRefOid;
          ctx.db.raw
            .prepare("UPDATE approvals SET payload_json = ? WHERE id = ?")
            .run(JSON.stringify(payload), existing.id);
        } else {
          ctx.db.createApproval({
            approval_type: "merge_pr",
            requested_by: "agent",
            work_item_id: link.work_item_id,
            payload: {
              pr_number: link.pr_number,
              pr_url: `https://github.com/${link.repository}/pull/${link.pr_number}`,
              repository: link.repository,
              branch_name: link.branch_name,
              head_sha: headRefOid,
            },
          });
        }
        lines.push(`#${link.pr_number} (${link.repository}): CI passing, ready to merge`);
      }
    }

    return { summary: lines.length > 0 ? lines.join("\n") : "All open PRs healthy." };
  };
}
