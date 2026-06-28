import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { buildPrApprovalPack, buildWorkItemApprovalPack, escapeHtml } from "../src/approvalHtml.js";

describe("approvalHtml", () => {
  it("escapes raw values", () => {
    expect(escapeHtml(`<script>"x" & 'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;");
  });

  it("builds an escaped work item approval pack", () => {
    const db = openDb(":memory:");
    try {
      const item = db.createWorkItem({
        kind: "feature",
        source: "telegram",
        repository: "owner/repo",
        title: "Add <danger>",
        body: "Plan with <script>alert(1)</script>",
        created_by: "user",
      });
      db.createWorkJob({ task_type: "tdd_implementation", idempotency_key: "tdd:html", work_item_id: item.id });

      const pack = buildWorkItemApprovalPack(db, item);

      expect(pack.filename).toBe(`work-item-${item.id}.html`);
      expect(pack.caption).toContain("Feature Work Item");
      expect(pack.html).toContain("Implementation Plan");
      expect(pack.html).toContain("Add &lt;danger&gt;");
      expect(pack.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(pack.html).not.toContain("<script>alert(1)</script>");
    } finally {
      db.close();
    }
  });

  it("builds a PR approval pack from merge approval payload", () => {
    const db = openDb(":memory:");
    try {
      const item = db.createWorkItem({
        kind: "defect",
        source: "defect_scan",
        repository: "owner/repo",
        title: "Fix bug",
        created_by: "worker",
      });
      db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 12, branch_name: "agent/work-12", commit_sha: "abc" });
      db.createApproval({
        approval_type: "merge_pr",
        requested_by: "agent",
        work_item_id: item.id,
        payload: {
          pr_url: "https://github.com/owner/repo/pull/12",
          head_sha: "abc",
        },
      });

      const pack = buildPrApprovalPack(db, item.id);

      expect(pack!.filename).toBe("pr-12.html");
      expect(pack!.html).toContain("PR Approval Pack");
      expect(pack!.html).toContain("https://github.com/owner/repo/pull/12");
      expect(pack!.html).toContain("agent/work-12");
    } finally {
      db.close();
    }
  });
});

