import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseWorkCallback, buildWorkCallback, handleWorkerCallback } from "../src/workCallbacks.js";
import { openDb } from "../src/db.js";

describe("work callback parser", () => {
  it("parses each valid callback format", () => {
    expect(parseWorkCallback("wi:123:view")).toEqual({ type: "wi_view", id: 123 });
    expect(parseWorkCallback("wi:456:appv")).toEqual({ type: "wi_appv", id: 456 });
    expect(parseWorkCallback("wi:789:clse")).toEqual({ type: "wi_clse", id: 789 });
    expect(parseWorkCallback("job:12:cncl")).toEqual({ type: "job_cncl", id: 12 });
    expect(parseWorkCallback("ap:34:yes")).toEqual({ type: "ap_yes", id: 34 });
    expect(parseWorkCallback("ap:56:no")).toEqual({ type: "ap_no", id: 56 });
  });

  it("rejectes unknown prefixes", () => {
    expect(parseWorkCallback("other:123:view")).toBeNull();
  });

  it("rejects unknown actions", () => {
    expect(parseWorkCallback("wi:123:other")).toBeNull();
  });

  it("rejects missing ids", () => {
    expect(parseWorkCallback("wi::view")).toBeNull();
  });

  it("rejects non-numeric ids", () => {
    expect(parseWorkCallback("wi:abc:view")).toBeNull();
  });

  it("rejects payloads over 64 bytes", () => {
    const longId = "9".repeat(60);
    expect(parseWorkCallback(`wi:${longId}:view`)).toBeNull();
  });
});

describe("work callback builder", () => {
  it("builds correct strings", () => {
    expect(buildWorkCallback({ type: "wi_view", id: 123 })).toBe("wi:123:view");
    expect(buildWorkCallback({ type: "wi_appv", id: 456 })).toBe("wi:456:appv");
    expect(buildWorkCallback({ type: "wi_clse", id: 789 })).toBe("wi:789:clse");
    expect(buildWorkCallback({ type: "job_cncl", id: 12 })).toBe("job:12:cncl");
    expect(buildWorkCallback({ type: "ap_yes", id: 34 })).toBe("ap:34:yes");
    expect(buildWorkCallback({ type: "ap_no", id: 56 })).toBe("ap:56:no");
    expect(buildWorkCallback({ type: "pr_hold", id: 78 })).toBe("pr:78:hold");
    expect(buildWorkCallback({ type: "pr_rels", id: 79 })).toBe("pr:79:rels");
    expect(buildWorkCallback({ type: "pr_rfsh", id: 80 })).toBe("pr:80:rfsh");
    expect(buildWorkCallback({ type: "pr_clse", id: 81 })).toBe("pr:81:clse");
  });

  it("throws or returns under 64 bytes", () => {
    const longId = 10 ** 15;
    const result = buildWorkCallback({ type: "wi_view", id: longId });
    expect(result.length).toBeLessThanOrEqual(64);
  });
});

describe("handleWorkerCallback (Slice 5)", () => {
  let db: any;
  let client: any;
  let oldGithubUsername: string | undefined;
  const allowedUserIds = new Set(["42"]);
  const validPlan = `## Problem Summary
Fix the work item.

## Target Files
- src/workCallbacks.ts
- test/workCallbacks.test.ts

## Architectural Intent
Keep approval gating explicit.

## Test Plan
Add a failing assertion in test/workCallbacks.test.ts.

## Implementation Phases
1. Red test.
2. Green implementation.

## Acceptance Criteria
- Approval queues implementation.

## Verification Commands
npm run typecheck
npm test`;

  beforeEach(() => {
    oldGithubUsername = process.env.GITHUB_USERNAME;
    process.env.GITHUB_USERNAME = "testuser";
    db = openDb(":memory:");
    client = {
      answerCallbackQuery: vi.fn().mockResolvedValue({}),
      editMessageText: vi.fn().mockResolvedValue({}),
      sendDocumentBuffer: vi.fn().mockResolvedValue({ ok: true }),
    };
  });

  afterEach(() => {
    db.close();
    if (oldGithubUsername === undefined) delete process.env.GITHUB_USERNAME;
    else process.env.GITHUB_USERNAME = oldGithubUsername;
  });

  it("rejects unauthorized users with answerCallbackQuery only", async () => {
    const cbq = {
      id: "cb-123",
      data: "wi:1:view",
      from: { id: 99 },
      message: { message_id: 100, chat: { id: 10 } },
    };
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(client.answerCallbackQuery).toHaveBeenCalledWith({
      callback_query_id: "cb-123",
      text: "Unauthorized",
    });
    expect(client.editMessageText).not.toHaveBeenCalled();
  });

  it("handles wi:id:view by showing work item details", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "defect_scan", title: "Leak", created_by: "worker" });
    const cbq = {
      id: "cb-123",
      data: `wi:${item.id}:view`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 }, message_thread_id: 44 },
    };
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(client.answerCallbackQuery).toHaveBeenCalledWith({ callback_query_id: "cb-123" });
    expect(db.getSetting("active_work_item:10")).toBe(String(item.id));
    expect(client.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 10,
        message_id: 100,
        text: expect.stringContaining("Leak"),
      })
    );
    expect(client.sendDocumentBuffer).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 10,
      message_thread_id: 44,
      filename: `work-item-${item.id}.html`,
      mime_type: "text/html",
    }));
  });

  it("queues implementation planning instead of approving when plan is missing", async () => {
    const item = db.createWorkItem({
      kind: "feature",
      source: "github",
      title: "Imported feature",
      body: "Raw issue only",
      repository: "owner/repo",
      created_by: "user",
    });
    const cbq = {
      id: "cb-plan-first",
      data: `wi:${item.id}:appv`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };

    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

    const jobs = db.listWorkJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].task_type).toBe("implementation_plan");
    expect(JSON.parse(jobs[0].input_json).approve_after_plan).toBe(true);
    expect(db.getWorkItem(item.id)!.status).toBe("proposed");
    expect(client.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Implementation plan queued"),
    }));
  });

  it("edits messages with Telegram entities instead of literal markdown markers", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "defect_scan", title: "Leak", created_by: "worker" });
    const cbq = {
      id: "cb-fmt",
      data: `wi:${item.id}:view`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

    const params = client.editMessageText.mock.calls[0][0];
    // No raw markers may reach Telegram
    expect(params.text).not.toContain("**");
    expect(params.text).not.toContain("`");
    // Formatting arrives as native entities
    const types = (params.entities ?? []).map((e: any) => e.type);
    expect(types).toContain("bold");
    expect(types).toContain("code");
  });

  it("handles wi:id:appv by approving and creating exactly one job", async () => {
    const item = db.createWorkItem({
      kind: "defect", source: "defect_scan", title: "Leak", created_by: "worker",
      repository: "owner/repo",
    });
    db.setWorkItemPlan(item.id, validPlan, { valid: true });
    const cbq = {
      id: "cb-123",
      data: `wi:${item.id}:appv`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };
    db.setSetting("active_work_item:10", String(item.id));

    // First tap
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(client.sendDocumentBuffer).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 10,
      filename: `work-item-${item.id}.html`,
    }));
    expect(db.getWorkItem(item.id)!.status).toBe("approved");
    expect(db.getSetting("active_work_item:10")).toBeNull();
    const jobs = db.listWorkJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs.map(j => j.task_type)).toEqual(["open_github_issue", "tdd_implementation"]);
    expect(client.editMessageText).toHaveBeenCalled();

    // Second tap (idempotent check)
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(db.listWorkJobs()).toHaveLength(2);
  });

  it("continues approval when the work item HTML pack upload fails", async () => {
    client.sendDocumentBuffer.mockRejectedValueOnce(new Error("telegram down"));
    const item = db.createWorkItem({
      kind: "refactor",
      source: "refactor_scan",
      title: "Clean boundary",
      created_by: "worker",
      repository: "owner/repo",
    });
    db.setWorkItemPlan(item.id, validPlan, { valid: true });
    const cbq = {
      id: "cb-doc-fail",
      data: `wi:${item.id}:appv`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };

    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

    expect(db.getWorkItem(item.id)!.status).toBe("approved");
    expect(db.listWorkJobs().map(j => j.task_type)).toEqual(["open_github_issue", "tdd_implementation"]);
    expect(client.editMessageText).toHaveBeenCalled();
  });

  it("handles wi:id:clse by closing the work item", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "defect_scan", title: "Leak", created_by: "worker" });
    const cbq = {
      id: "cb-123",
      data: `wi:${item.id}:clse`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };
    db.setSetting("active_work_item:10", String(item.id));
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(db.getWorkItem(item.id)!.status).toBe("closed");
    expect(db.getSetting("active_work_item:10")).toBeNull();
    expect(client.editMessageText).toHaveBeenCalled();
  });

  it("handles job:id:cncl by cancelling the job", async () => {
    const job = db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:1" });
    const cbq = {
      id: "cb-123",
      data: `job:${job.id}:cncl`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(db.getWorkJob(job.id)!.status).toBe("cancelled");
    expect(client.editMessageText).toHaveBeenCalled();
  });

  it("handles ap:id:yes by approving the approval request", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "X", created_by: "user:1" });
    const appr = db.createApproval({ work_item_id: item.id, approval_type: "merge_pr", requested_by: "worker" });
    const cbq = {
      id: "cb-123",
      data: `ap:${appr.id}:yes`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    const updated = db.getWorkItem(item.id); // Check that approval resolver was called
    const row = db.raw.prepare(`SELECT * FROM approvals WHERE id = ?`).get(appr.id);
    expect(row.status).toBe("approved");
    expect(client.editMessageText).toHaveBeenCalled();
  });

  it("handles ap:id:no by rejecting the approval request", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "X", created_by: "user:1" });
    const appr = db.createApproval({ work_item_id: item.id, approval_type: "merge_pr", requested_by: "worker" });
    const cbq = {
      id: "cb-123",
      data: `ap:${appr.id}:no`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    const row = db.raw.prepare(`SELECT * FROM approvals WHERE id = ?`).get(appr.id);
    expect(row.status).toBe("rejected");
    expect(client.editMessageText).toHaveBeenCalled();
  });

  it("queues an open_github_issue job on wi_appv when repository is set", async () => {
    const item = db.createWorkItem({
      kind: "defect", source: "defect_scan",
      title: "Race condition", created_by: "worker",
      repository: "owner/repo",
    });
    db.setWorkItemPlan(item.id, validPlan, { valid: true });
    const cbq = {
      id: "cb-gh",
      data: `wi:${item.id}:appv`,
      from: { id: 42 },
      message: { message_id: 200, chat: { id: 10 } },
    };

    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

    const jobs = db.listWorkJobs();
    const ghJob = jobs.find(j => j.task_type === "open_github_issue");
    expect(ghJob).toBeDefined();
    const input = JSON.parse(ghJob!.input_json);
    expect(input.work_item_id).toBe(item.id);
    expect(input.repository).toBe("owner/repo");
  });

  it("passes work_item_id and notify_chat_id in tdd_implementation input_json on wi_appv", async () => {
    const item = db.createWorkItem({
      kind: "defect", source: "defect_scan",
      title: "Leaked handle", created_by: "worker",
      repository: "owner/repo",
    });
    db.setWorkItemPlan(item.id, validPlan, { valid: true });
    const cbq = {
      id: "cb-input",
      data: `wi:${item.id}:appv`,
      from: { id: 42 },
      message: { message_id: 300, chat: { id: 777 } },
    };

    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

    const tddJob = db.listWorkJobs().find(j => j.task_type === "tdd_implementation");
    expect(tddJob).toBeDefined();
    const input = JSON.parse(tddJob!.input_json);
    expect(input.work_item_id).toBe(item.id);
    expect(input.repository).toBe("owner/repo");
    expect(input.notify_chat_id).toBe(777);
  });

  it("passes notify_chat_id in open_github_issue input_json and creates it before the tdd job", async () => {
    const item = db.createWorkItem({
      kind: "defect", source: "defect_scan",
      title: "Race condition", created_by: "worker",
      repository: "owner/repo",
    });
    db.setWorkItemPlan(item.id, validPlan, { valid: true });
    const cbq = {
      id: "cb-order",
      data: `wi:${item.id}:appv`,
      from: { id: 42 },
      message: { message_id: 301, chat: { id: 888 } },
    };

    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

    const jobs = db.listWorkJobs();
    const ghJob = jobs.find(j => j.task_type === "open_github_issue");
    const tddJob = jobs.find(j => j.task_type === "tdd_implementation");
    expect(ghJob).toBeDefined();
    expect(tddJob).toBeDefined();
    expect(JSON.parse(ghJob!.input_json).notify_chat_id).toBe(888);
    // Issue job must be enqueued before the implementation job
    expect(ghJob!.id).toBeLessThan(tddJob!.id);
  });

  it("does not approve or queue implementation when repository is not set", async () => {
    const item = db.createWorkItem({
      kind: "defect", source: "defect_scan",
      title: "Bug with no repo", created_by: "worker",
    });
    const cbq = {
      id: "cb-no-gh",
      data: `wi:${item.id}:appv`,
      from: { id: 42 },
      message: { message_id: 201, chat: { id: 10 } },
    };

    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

    const jobs = db.listWorkJobs();
    const ghJob = jobs.find(j => j.task_type === "open_github_issue");
    const tddJob = jobs.find(j => j.task_type === "tdd_implementation");
    expect(ghJob).toBeUndefined();
    expect(tddJob).toBeUndefined();
    expect(db.getWorkItem(item.id)?.status).toBe("proposed");
    expect(client.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/repository/i),
    }));
  });

  it("rs:<repo>:r creates a defect scan job for the selected GitHub repo", async () => {
    const cbq = {
      id: "cb-rs-r",
      data: "rs:agent-bridge:r",
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };

    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

    const job = db.listWorkJobs()[0];
    expect(job.task_type).toBe("defect_scan");
    expect(JSON.parse(job.input_json).repository).toBe("testuser/agent-bridge");
    expect(JSON.parse(job.input_json).notify_chat_id).toBe(10);
    expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Defect scan queued"),
    }));
  });

  it("rs:<repo>:rf creates a refactor scan job for the selected GitHub repo", async () => {
    const cbq = {
      id: "cb-rs-rf",
      data: "rs:agent-bridge:rf",
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };

    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

    const job = db.listWorkJobs()[0];
    expect(job.task_type).toBe("refactor_scan");
    expect(JSON.parse(job.input_json).repository).toBe("testuser/agent-bridge");
    expect(JSON.parse(job.input_json).notify_chat_id).toBe(10);
  });

  it("rs:<repo>:f consumes pending feature brief and creates a feature plan job", async () => {
    const { setPendingRepoBrief } = await import("../src/featureBriefCapture.js");
    setPendingRepoBrief("10", "add repo picker");
    const cbq = {
      id: "cb-rs-f",
      data: "rs:content-crawler:f",
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };

    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

    const plan = db.getActivePlanForChat("10");
    expect(plan!.brief).toBe("add repo picker");
    const job = db.listWorkJobs()[0];
    expect(job.task_type).toBe("feature_plan");
    expect(JSON.parse(job.input_json).repository).toBe("testuser/content-crawler");
    expect(JSON.parse(job.input_json).plan_id).toBe(plan!.id);
  });

  it("rs:<repo>:f without a pending brief answers with an error", async () => {
    const cbq = {
      id: "cb-rs-f-empty",
      data: "rs:agent-bridge:f",
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };

    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

    expect(db.listWorkJobs()).toHaveLength(0);
    expect(client.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/No pending feature brief/i),
    }));
  });

  it("rs:<repo>:r answers clearly when GITHUB_USERNAME is missing", async () => {
    delete process.env.GITHUB_USERNAME;
    const cbq = {
      id: "cb-rs-no-owner",
      data: "rs:agent-bridge:r",
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };

    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

    expect(db.listWorkJobs()).toHaveLength(0);
    expect(client.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
      text: "GITHUB_USERNAME env var is not set",
    }));
  });

  describe("gi: — GitHub issue import callbacks", () => {
    it("gi:<repo>:<num> imports issue and creates a work item", async () => {
      const issuePayload = JSON.stringify({
        number: 42,
        title: "Fix login bug",
        body: "Steps to reproduce...",
        labels: [{ name: "bug" }],
      });
      const runCommand = vi.fn().mockResolvedValue(issuePayload);
      const cbq = {
        id: "cb-gi-1",
        data: "gi:agent-bridge:42",
        from: { id: 42 },
        message: { message_id: 200, chat: { id: 10 } },
      };

      await handleWorkerCallback(cbq as any, db, client, allowedUserIds, { runCommand });

      const items = db.listWorkItems();
      expect(items).toHaveLength(1);
      expect(items[0].kind).toBe("defect");
      expect(items[0].title).toBe("Fix login bug");
      expect(runCommand).toHaveBeenCalledWith("gh", expect.arrayContaining(["issue", "view", "42", "--repo", "testuser/agent-bridge"]));
      expect(client.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("Imported #42"),
      }));
      expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("Fix login bug"),
      }));
    });

    it("gi:<owner/repo>:<num> preserves external repository owner", async () => {
      const issuePayload = JSON.stringify({
        number: 42,
        title: "Fix external bug",
        body: "Steps to reproduce...",
        labels: [{ name: "bug" }],
      });
      const runCommand = vi.fn().mockResolvedValue(issuePayload);
      const cbq = {
        id: "cb-gi-external",
        data: "gi:external/repo:42",
        from: { id: 42 },
        message: { message_id: 200, chat: { id: 10 } },
      };

      await handleWorkerCallback(cbq as any, db, client, allowedUserIds, { runCommand });

      expect(runCommand).toHaveBeenCalledWith("gh", expect.arrayContaining(["issue", "view", "42", "--repo", "external/repo"]));
      expect(db.listWorkItems()[0].repository).toBe("external/repo");
    });

    it("gi:<repo>:<num> reuses an already imported issue", async () => {
      const existing = db.createWorkItem({
        kind: "feature",
        source: "github",
        title: "Existing",
        created_by: "worker",
        repository: "testuser/agent-bridge",
      });
      db.linkGithubIssue({ work_item_id: existing.id, repository: "testuser/agent-bridge", issue_number: 42 });
      const runCommand = vi.fn();
      const cbq = {
        id: "cb-gi-existing",
        data: "gi:agent-bridge:42",
        from: { id: 42 },
        message: { message_id: 200, chat: { id: 10 } },
      };

      await handleWorkerCallback(cbq as any, db, client, allowedUserIds, { runCommand });

      expect(runCommand).not.toHaveBeenCalled();
      expect(db.listWorkItems()).toHaveLength(1);
      expect(client.answerCallbackQuery).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining(`work item #${existing.id}`),
      }));
    });

    it("gi:<repo>:<num> skips open_github_issue when approved", async () => {
      const issuePayload = JSON.stringify({
        number: 7,
        title: "Refactor auth module",
        body: "It is messy.",
        labels: [{ name: "refactor" }],
      });
      const runCommand = vi.fn().mockResolvedValue(issuePayload);
      const importCbq = {
        id: "cb-gi-import",
        data: "gi:agent-bridge:7",
        from: { id: 42 },
        message: { message_id: 201, chat: { id: 10 } },
      };
      await handleWorkerCallback(importCbq as any, db, client, allowedUserIds, { runCommand });

      const item = db.listWorkItems()[0];
      const approveCbq = {
        id: "cb-gi-appv",
        data: `wi:${item.id}:appv`,
        from: { id: 42 },
        message: { message_id: 202, chat: { id: 10 } },
      };
      await handleWorkerCallback(approveCbq as any, db, client, allowedUserIds);

      const jobs = db.listWorkJobs();
      const taskTypes = jobs.map(j => j.task_type);
      expect(taskTypes).not.toContain("open_github_issue");
    });

    it("gi: with malformed callback is ignored gracefully", async () => {
      const cbq = {
        id: "cb-gi-bad",
        data: "gi:only-two-parts",
        from: { id: 42 },
        message: { message_id: 203, chat: { id: 10 } },
      };

      await handleWorkerCallback(cbq as any, db, client, allowedUserIds);

      expect(db.listWorkItems()).toHaveLength(0);
      expect(client.answerCallbackQuery).toHaveBeenCalled();
    });
  });

  it("sends a PR approval HTML pack before merge callback handling", async () => {
    const item = db.createWorkItem({
      kind: "defect",
      source: "defect_scan",
      title: "Merge candidate",
      created_by: "worker",
      repository: "owner/repo",
    });
    const link = db.linkGithubPr({
      work_item_id: item.id,
      repository: "owner/repo",
      pr_number: 44,
      branch_name: "agent/work-44",
      commit_sha: "abc123",
    });
    db.updatePrState(link.id, "ready_to_merge");
    db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: {
        pr_number: 44,
        pr_url: "https://github.com/owner/repo/pull/44",
        repository: "owner/repo",
        branch_name: "agent/work-44",
        head_sha: "abc123",
      },
    });
    const runCommand = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("view")) {
        return JSON.stringify({
          headRefOid: "abc123",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        });
      }
      return "";
    });
    const cbq = {
      id: "cb-pr-pack",
      data: `wi:${item.id}:mrgpr`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 }, message_thread_id: 55 },
    };

    await handleWorkerCallback(cbq as any, db, client, allowedUserIds, { runCommand });

    expect(client.sendDocumentBuffer).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 10,
      message_thread_id: 55,
      filename: "pr-44.html",
      mime_type: "text/html",
    }));
    expect(db.getWorkItem(item.id)!.status).toBe("resolved");
  });

  it("cancels pending jobs linked to the work item on wi:id:clse", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "defect_scan", title: "Pending Cancel", created_by: "worker" });
    const job = db.createWorkJob({ task_type: "tdd_implementation", idempotency_key: "tdd:cancel-test", work_item_id: item.id });
    const cbq = {
      id: "cb-clse-cancel",
      data: `wi:${item.id}:clse`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(db.getWorkItem(item.id)!.status).toBe("closed");
    expect(db.getWorkJob(job.id)!.status).toBe("cancelled");
  });

  it("cancels leased jobs linked to the work item on wi:id:clse", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "defect_scan", title: "Leased Cancel", created_by: "worker" });
    const job = db.createWorkJob({ task_type: "tdd_implementation", idempotency_key: "tdd:cancel-leased", work_item_id: item.id });
    db.claimNextWorkJob("worker-1", new Date().toISOString(), 60, job.id);
    const cbq = {
      id: "cb-clse-leased",
      data: `wi:${item.id}:clse`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(db.getWorkItem(item.id)!.status).toBe("closed");
    expect(db.getWorkJob(job.id)!.status).toBe("cancelled");
  });

  it("cancels running jobs linked to the work item on wi:id:clse", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "defect_scan", title: "Running Cancel", created_by: "worker" });
    const job = db.createWorkJob({ task_type: "tdd_implementation", idempotency_key: "tdd:cancel-running", work_item_id: item.id });
    db.raw.prepare(`UPDATE work_jobs SET status = 'running' WHERE id = ?`).run(job.id);
    const cbq = {
      id: "cb-clse-running",
      data: `wi:${item.id}:clse`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(db.getWorkItem(item.id)!.status).toBe("closed");
    expect(db.getWorkJob(job.id)!.status).toBe("cancelled");
  });
});

// ── Phase 9 Slice 22: stale PR hold/release/close callbacks ──────────────────

import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

describe("stale PR callbacks — pr:<id>:hold/rels/clse", () => {
  let db2: ReturnType<typeof openDb>;
  let dbPath2: string;

  beforeEach(() => {
    dbPath2 = join(tmpdir(), `wcb-stale-test-${Date.now()}-${Math.random()}.sqlite`);
    db2 = openDb(dbPath2);
  });
  afterEach(() => { db2.close(); try { rmSync(dbPath2); } catch {} });

  const allowedIds = new Set(["77"]);

  function makeClient() {
    return {
      answerCallbackQuery: vi.fn().mockResolvedValue({}),
      editMessageText: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockResolvedValue({}),
    };
  }

  it("hold callback sets pr_state to held", async () => {
    const item = db2.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db2.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 5, branch_name: "agent/x" });

    const cl = makeClient();
    await handleWorkerCallback(
      { id: "cb1", data: `pr:${link.id}:hold`, from: { id: 77 }, message: { message_id: 1, chat: { id: 10 } } } as any,
      db2, cl as any, allowedIds,
    );

    const row = db2.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(row.pr_state).toBe("held");
    expect(cl.answerCallbackQuery).toHaveBeenCalled();
  });

  it("release callback sets pr_state back to draft", async () => {
    const item = db2.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db2.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 6, branch_name: "agent/y" });
    db2.updatePrState(link.id, "held");

    const cl = makeClient();
    await handleWorkerCallback(
      { id: "cb2", data: `pr:${link.id}:rels`, from: { id: 77 }, message: { message_id: 1, chat: { id: 10 } } } as any,
      db2, cl as any, allowedIds,
    );

    const row = db2.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(row.pr_state).toBe("draft");
    expect(cl.answerCallbackQuery).toHaveBeenCalled();
  });

  it("close callback calls gh pr close and closes the work item", async () => {
    const item = db2.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db2.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 7, branch_name: "agent/z" });

    const cl = makeClient();
    const runCommand = vi.fn().mockResolvedValue("");
    await handleWorkerCallback(
      { id: "cb3", data: `pr:${link.id}:clse`, from: { id: 77 }, message: { message_id: 1, chat: { id: 10 } } } as any,
      db2, cl as any, allowedIds,
      { runCommand },
    );

    expect(runCommand).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "close", "7", "--repo", "owner/repo"]),
    );
    const updatedItem = db2.getWorkItem(item.id)!;
    expect(updatedItem.status).toBe("closed");
  });

  it("rejects unauthorized user", async () => {
    const item = db2.createWorkItem({ kind: "defect", source: "telegram", title: "T", created_by: "w" });
    const link = db2.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 8, branch_name: "agent/w" });

    const cl = makeClient();
    await handleWorkerCallback(
      { id: "cb4", data: `pr:${link.id}:hold`, from: { id: 999 }, message: { message_id: 1, chat: { id: 10 } } } as any,
      db2, cl as any, allowedIds,
    );

    const row = db2.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(row.pr_state).toBe("draft"); // unchanged
    expect(cl.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/unauthorized/i) })
    );
  });
});
