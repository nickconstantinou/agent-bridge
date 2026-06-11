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
  const allowedUserIds = new Set(["42"]);

  beforeEach(() => {
    db = openDb(":memory:");
    client = {
      answerCallbackQuery: vi.fn().mockResolvedValue({}),
      editMessageText: vi.fn().mockResolvedValue({}),
    };
  });

  afterEach(() => {
    db.close();
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
      message: { message_id: 100, chat: { id: 10 } },
    };
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(client.answerCallbackQuery).toHaveBeenCalledWith({ callback_query_id: "cb-123" });
    expect(client.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 10,
        message_id: 100,
        text: expect.stringContaining("Leak"),
      })
    );
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
    const item = db.createWorkItem({ kind: "defect", source: "defect_scan", title: "Leak", created_by: "worker" });
    const cbq = {
      id: "cb-123",
      data: `wi:${item.id}:appv`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };

    // First tap
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(db.getWorkItem(item.id)!.status).toBe("approved");
    const jobs = db.listWorkJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].task_type).toBe("tdd_implementation");
    expect(client.editMessageText).toHaveBeenCalled();

    // Second tap (idempotent check)
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(db.listWorkJobs()).toHaveLength(1);
  });

  it("handles wi:id:clse by closing the work item", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "defect_scan", title: "Leak", created_by: "worker" });
    const cbq = {
      id: "cb-123",
      data: `wi:${item.id}:clse`,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 10 } },
    };
    await handleWorkerCallback(cbq as any, db, client, allowedUserIds);
    expect(db.getWorkItem(item.id)!.status).toBe("closed");
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

  it("does not queue open_github_issue when repository is not set", async () => {
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
    expect(ghJob).toBeUndefined();
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

  it("does not cancel running jobs linked to the work item on wi:id:clse", async () => {
    const item = db.createWorkItem({ kind: "defect", source: "defect_scan", title: "Running Skip", created_by: "worker" });
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
    expect(db.getWorkJob(job.id)!.status).toBe("running");
  });
});
