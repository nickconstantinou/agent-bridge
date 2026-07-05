import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createPrWatchHandler } from "../src/handlers/prWatch.js";

function makeDb() {
  const dbPath = join(tmpdir(), `pr-watch-rollup-state-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

function prViewPayload(statusCheckRollup: unknown[], headRefOid = "state-sha") {
  return JSON.stringify({
    headRefOid,
    statusCheckRollup,
    mergeable: "MERGEABLE",
    updatedAt: new Date().toISOString(),
    state: "OPEN",
  });
}

describe("createPrWatchHandler rollup state classification", () => {
  it("treats commit status state=FAILURE as failing and queues one CI fix job", async () => {
    const { db, dbPath } = makeDb();
    try {
      const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
      const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 70, branch_name: "agent/work-70" });
      const runCommand = async (_binary: string, args: string[]) => {
        if (args[0] === "pr" && args[1] === "view") {
          return prViewPayload([{ __typename: "StatusContext", state: "FAILURE", name: "ci/test" }], "state-fail-sha");
        }
        return "";
      };

      await createPrWatchHandler({ runCommand })({}, { db, workerId: "w", phase: "initial", phaseData: {} });

      const updated = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as { pr_state: string };
      expect(updated.pr_state).toBe("ci_failed");
      const job = db.raw.prepare("SELECT * FROM work_jobs WHERE idempotency_key = ?").get("ci_fix:owner/repo:70:state-fail-sha") as { input_json: string } | undefined;
      expect(job).toBeDefined();
      expect(JSON.parse(job!.input_json).ci_failure_summary).toContain("ci/test: FAILURE");
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });

  it("treats commit status state=SUCCESS as passing and creates merge approval", async () => {
    const { db, dbPath } = makeDb();
    try {
      const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
      const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 71, branch_name: "agent/work-71" });
      const runCommand = async (_binary: string, args: string[]) => {
        if (args[0] === "pr" && args[1] === "view") {
          return prViewPayload([{ __typename: "StatusContext", state: "SUCCESS", name: "ci/test" }], "state-success-sha");
        }
        return "";
      };

      await createPrWatchHandler({ runCommand })({}, { db, workerId: "w", phase: "initial", phaseData: {} });

      const updated = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as { pr_state: string };
      expect(updated.pr_state).toBe("ready_to_merge");
      const approval = db.raw.prepare("SELECT * FROM approvals WHERE work_item_id = ? AND approval_type = 'merge_pr'").get(item.id) as { payload_json: string } | undefined;
      expect(approval).toBeDefined();
      expect(JSON.parse(approval!.payload_json).head_sha).toBe("state-success-sha");
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });
});
