import type { BridgeDb } from "./db.js";

type RunCommand = (binary: string, args: string[]) => Promise<string>;

export async function closeLinkedIssueForMergedPr(
  db: BridgeDb,
  runCommand: RunCommand,
  workItemId: number,
  repository: string,
  prNumber: number | null | undefined,
): Promise<void> {
  const issue = db.raw.prepare(
    `SELECT issue_number, repository
     FROM github_links
     WHERE work_item_id = ?
       AND issue_number IS NOT NULL
     ORDER BY id ASC
     LIMIT 1`,
  ).get(workItemId) as { issue_number: number; repository: string } | undefined;
  if (!issue) return;

  const repo = issue.repository || repository;
  const comment = prNumber != null
    ? `Closed by Agent Bridge: implemented by merged PR #${prNumber}.`
    : "Closed by Agent Bridge: linked pull request was merged.";

  try {
    await runCommand("gh", [
      "issue", "close", String(issue.issue_number),
      "--repo", repo,
      "--comment", comment,
    ]);
  } catch {
    // Closing is idempotent/best-effort. A closed issue must not block merge
    // approval resolution or local state reconciliation.
  }
}
