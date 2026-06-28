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
import type { GithubLink } from "../db.js";

type RunCommand = (binary: string, args: string[]) => Promise<string>;

interface PrWatchDeps {
  runCommand: RunCommand;
  /** Hours without activity before a PR is considered stale (default 72). */
  staleHours?: number;
  /** Called once per run with the list of PRs newly marked stale (if any). */
  notifyStale?: (stalePrs: GithubLink[]) => Promise<void> | void;
}

interface GhPrView {
  headRefOid: string;
  statusCheckRollup: Array<{ __typename: string; conclusion: string; name: string; detailsUrl?: string }>;
  mergeable: string;
  updatedAt: string;
}

function isRollupFailing(rollup: GhPrView["statusCheckRollup"]): boolean {
  return rollup.some(c => c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT");
}

function isRollupPassing(rollup: GhPrView["statusCheckRollup"]): boolean {
  return rollup.length > 0 && rollup.every(c => c.conclusion === "SUCCESS");
}

function failedChecks(rollup: GhPrView["statusCheckRollup"]): GhPrView["statusCheckRollup"] {
  return rollup.filter(c => c.conclusion === "FAILURE" || c.conclusion === "TIMED_OUT");
}

function extractActionsRunId(detailsUrl: string | undefined): string | null {
  const match = detailsUrl?.match(/\/actions\/runs\/(\d+)/);
  return match ? match[1] : null;
}

async function collectFailureLog(
  runCommand: RunCommand,
  repository: string,
  rollup: GhPrView["statusCheckRollup"],
): Promise<string> {
  const logs: string[] = [];
  for (const check of failedChecks(rollup)) {
    const runId = extractActionsRunId(check.detailsUrl);
    if (!runId) continue;
    try {
      const output = await runCommand("gh", [
        "run", "view", runId,
        "--repo", repository,
        "--log-failed",
      ]);
      if (output.trim()) logs.push(`## ${check.name}\n${output.trim()}`);
    } catch {
      // Log capture is diagnostic only; CI failure handling still proceeds.
    }
  }
  return logs.join("\n\n").slice(-12000);
}

export function createPrWatchHandler(deps: PrWatchDeps): JobHandler {
  const { runCommand, staleHours = 72, notifyStale } = deps;
  const staleThresholdMs = staleHours * 60 * 60 * 1000;

  return async function prWatchHandler(
    _input: JobHandlerInput,
    ctx: JobHandlerContext,
  ): Promise<JobHandlerResult> {
    const openPrs = ctx.db.listAllOpenAgentPrs();
    if (openPrs.length === 0) return { summary: "No open agent PRs to watch." };

    const now = Date.now();
    const lines: string[] = [];
    const newlyStale: GithubLink[] = [];

    for (const link of openPrs) {
      if (link.pr_state === "held") continue;

      const viewOutput = await runCommand("gh", [
        "pr", "view", String(link.pr_number),
        "--repo", link.repository.includes("/") ? link.repository : `nickconstantinou/${link.repository}`,
        "--json", "headRefOid,statusCheckRollup,mergeable,updatedAt",
      ]);

      const prData = JSON.parse(viewOutput) as GhPrView;
      const { headRefOid, statusCheckRollup, updatedAt } = prData;

      // Stale check takes priority over CI state
      const updatedAtMs = new Date(updatedAt).getTime();
      if (now - updatedAtMs > staleThresholdMs) {
        ctx.db.updatePrState(link.id, "stale");
        newlyStale.push(link);
        lines.push(`#${link.pr_number} (${link.repository}): marked stale`);
        continue;
      }

      if (isRollupFailing(statusCheckRollup)) {
        const fixKey = `ci_fix:${link.repository}:${link.pr_number}:${headRefOid}`;
        const existingFix = ctx.db.raw
          .prepare("SELECT * FROM work_jobs WHERE idempotency_key = ?")
          .get(fixKey) as { status: string; error?: string | null } | undefined;

        if (existingFix && (existingFix.status === "failed" || existingFix.status === "completed")) {
          ctx.db.updatePrState(link.id, "ci_failed_needs_human");
          lines.push(`#${link.pr_number} (${link.repository}): CI still failing after auto-fix attempt; needs human review`);
          continue;
        }

        ctx.db.updatePrState(link.id, "ci_failed");
        const failures = failedChecks(statusCheckRollup);
        const ciFailureSummary = failures.map(c => `${c.name}: ${c.conclusion}`).join("\n");
        const ciFailureLog = await collectFailureLog(runCommand, link.repository, statusCheckRollup);
        const fixJob = ctx.db.createWorkJob({
          task_type: "tdd_implementation",
          idempotency_key: fixKey,
          work_item_id: link.work_item_id,
          input_json: {
            work_item_id: link.work_item_id,
            repository: link.repository,
            branch_name: link.branch_name,
            ci_fix: true,
            ci_failure_summary: ciFailureSummary,
            ...(ciFailureLog ? { ci_failure_log: ciFailureLog } : {}),
          },
          max_attempts: 1,
        });
        if (fixJob.status === "failed" || fixJob.status === "completed") {
          ctx.db.updatePrState(link.id, "ci_failed_needs_human");
          lines.push(`#${link.pr_number} (${link.repository}): CI still failing after auto-fix attempt; needs human review`);
        } else {
          lines.push(`#${link.pr_number} (${link.repository}): CI failing, fix job #${fixJob.id} enqueued`);
        }
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

    if (newlyStale.length > 0 && notifyStale) await notifyStale(newlyStale);

    return { summary: lines.length > 0 ? lines.join("\n") : "All open PRs healthy." };
  };
}
