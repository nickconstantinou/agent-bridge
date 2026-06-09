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
});
