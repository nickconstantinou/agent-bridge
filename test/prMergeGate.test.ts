/**
 * Tests for the PR merge gate — inline keyboard notification after pr_lifecycle
 * completes, and the wi_mrgpr / wi_clspr callback handlers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { buildPrMergeKeyboard, parsePrMergeCallback } from "../src/prMergeGate.js";

function makeDb() {
  const dbPath = join(tmpdir(), `pr-merge-gate-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

describe("parsePrMergeCallback", () => {
  it("parses wi:<id>:mrgpr", () => {
    const result = parsePrMergeCallback("wi:42:mrgpr");
    expect(result).toEqual({ type: "wi_mrgpr", id: 42 });
  });

  it("parses wi:<id>:clspr", () => {
    const result = parsePrMergeCallback("wi:7:clspr");
    expect(result).toEqual({ type: "wi_clspr", id: 7 });
  });

  it("returns null for unknown action", () => {
    expect(parsePrMergeCallback("wi:1:appv")).toBeNull();
    expect(parsePrMergeCallback("garbage")).toBeNull();
  });

  it("returns null for non-integer id", () => {
    expect(parsePrMergeCallback("wi:abc:mrgpr")).toBeNull();
  });
});

describe("buildPrMergeKeyboard", () => {
  it("returns an inline_keyboard with Merge and Close buttons", () => {
    const keyboard = buildPrMergeKeyboard(5);
    expect(keyboard.inline_keyboard).toHaveLength(1);
    const row = keyboard.inline_keyboard[0];
    expect(row).toHaveLength(2);
    const merge = row.find((b: any) => b.callback_data === "wi:5:mrgpr");
    const close = row.find((b: any) => b.callback_data === "wi:5:clspr");
    expect(merge).toBeDefined();
    expect(close).toBeDefined();
  });

  it("callback_data for each button is within 64 bytes", () => {
    const keyboard = buildPrMergeKeyboard(999999);
    for (const row of keyboard.inline_keyboard) {
      for (const btn of row) {
        expect(btn.callback_data.length).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("handlePrMergeCallback — wi_mrgpr", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb());
  });
  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("resolves the merge_pr approval and merges via gh pr merge", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });
    const approval = db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_url: "https://github.com/owner/repo/pull/3", pr_number: 3, branch_name: "agent/work-1", repository: "owner/repo" },
    });

    const runCommand = vi.fn().mockResolvedValue("Pull request #3 was merged");
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await handlePrMergeCallback(
      { type: "wi_mrgpr", id: item.id },
      { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1" }
    );

    expect(runCommand).toHaveBeenCalledOnce();
    const [binary, args]: [string, string[]] = runCommand.mock.calls[0];
    expect(binary).toBe("gh");
    expect(args).toContain("merge");
    expect(args).toContain("--squash");

    const resolved = db.raw.prepare("SELECT * FROM approvals WHERE id = ?").get(approval.id) as any;
    expect(resolved.status).toBe("approved");

    expect(db.getWorkItem(item.id)!.status).toBe("resolved");
  });

  it("throws if no pending merge_pr approval exists for the work item", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
    });

    await expect(
      handlePrMergeCallback(
        { type: "wi_mrgpr", id: item.id },
        {
          db, runCommand: vi.fn(), answerCbq: vi.fn(),
          editMessage: vi.fn(), chatId: 1, messageId: 1, userId: "u"
        }
      )
    ).rejects.toThrow(/approval|not found/i);
  });
});

describe("handlePrMergeCallback — wi_clspr", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb());
  });
  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("closes the PR via gh pr close and transitions work item to closed", async () => {
    const { handlePrMergeCallback } = await import("../src/prMergeGate.js");

    const item = db.createWorkItem({
      kind: "defect", source: "telegram", title: "Bug", created_by: "worker",
      repository: "owner/repo",
    });
    db.createApproval({
      approval_type: "merge_pr",
      requested_by: "agent",
      work_item_id: item.id,
      payload: { pr_url: "https://github.com/owner/repo/pull/5", pr_number: 5, branch_name: "agent/work-1", repository: "owner/repo" },
    });

    const runCommand = vi.fn().mockResolvedValue("");
    const answerCbq = vi.fn().mockResolvedValue(undefined);
    const editMessage = vi.fn().mockResolvedValue(undefined);

    await handlePrMergeCallback(
      { type: "wi_clspr", id: item.id },
      { db, runCommand, answerCbq, editMessage, chatId: 100, messageId: 200, userId: "u1" }
    );

    const [binary, args]: [string, string[]] = runCommand.mock.calls[0];
    expect(binary).toBe("gh");
    expect(args).toContain("close");
    expect(db.getWorkItem(item.id)!.status).toBe("closed");
  });
});
