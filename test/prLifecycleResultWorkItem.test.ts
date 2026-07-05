import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { createPrLifecycleHandler } from "../src/handlers/prLifecycle.js";

function makeDb() {
  const dbPath = join(tmpdir(), `pr-lifecycle-result-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

function makeStubs() {
  return {
    runGit: async (args: string[]) => args[0] === "rev-parse" ? "headsha\n" : "",
    runCommand: async (_binary: string, args: string[]) => {
      if (args[0] === "pr" && args[1] === "create") return "https://github.com/owner/repo/pull/80";
      return "";
    },
  };
}

describe("createPrLifecycleHandler work item result metadata", () => {
  it("returns work_item_id when opening a new PR", async () => {
    const { db, dbPath } = makeDb();
    try {
      const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "worker" });
      const result = await createPrLifecycleHandler(makeStubs())(
        { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
        { db, workerId: "w", phase: "initial", phaseData: {} },
      );

      expect(result.work_item_id).toBe(item.id);
      expect(result.work_item_ids).toEqual([item.id]);
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });

  it("returns work_item_id when refreshing an existing PR", async () => {
    const { db, dbPath } = makeDb();
    try {
      const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "worker" });
      db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 81, branch_name: `agent/work-${item.id}` });

      const result = await createPrLifecycleHandler(makeStubs())(
        { work_item_id: item.id, branch_name: `agent/work-${item.id}`, repository: "owner/repo" },
        { db, workerId: "w", phase: "initial", phaseData: {} },
      );

      expect(result.work_item_id).toBe(item.id);
      expect(result.work_item_ids).toEqual([item.id]);
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });
});
