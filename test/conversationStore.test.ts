// test/conversationStore.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb, BridgeDb } from "../src/db.js";

let db: BridgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("conversation turns", () => {
  it("returns empty array when no turns exist", () => {
    expect(db.getRecentConvTurns("chat:1", 10)).toEqual([]);
  });

  it("stores and retrieves turns in order", () => {
    db.addConvTurn("chat:1", "user", "hello");
    db.addConvTurn("chat:1", "assistant", "world");
    const turns = db.getRecentConvTurns("chat:1", 10);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[0].text).toBe("hello");
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].text).toBe("world");
  });

  it("isolates turns by chatKey", () => {
    db.addConvTurn("chat:1", "user", "in chat 1");
    db.addConvTurn("chat:2", "user", "in chat 2");
    expect(db.getRecentConvTurns("chat:1", 10)).toHaveLength(1);
    expect(db.getRecentConvTurns("chat:2", 10)).toHaveLength(1);
  });

  it("respects limit — returns most recent N turns", () => {
    for (let i = 0; i < 8; i++) db.addConvTurn("chat:1", "user", `msg ${i}`);
    const turns = db.getRecentConvTurns("chat:1", 3);
    expect(turns).toHaveLength(3);
    expect(turns[2].text).toBe("msg 7");
  });

  it("stores optional cli field", () => {
    db.addConvTurn("chat:1", "user", "hi", "codex");
    const turns = db.getRecentConvTurns("chat:1", 1);
    expect(turns[0].cli).toBe("codex");
  });

  it("filters turns by sinceId", () => {
    db.addConvTurn("chat:1", "user", "before");
    const [before] = db.getRecentConvTurns("chat:1", 1);
    db.addConvTurn("chat:1", "assistant", "after");
    const turns = db.getRecentConvTurns("chat:1", 10, before.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("after");
  });
});

describe("buildConvContext", () => {
  it("returns empty string when no turns", () => {
    expect(db.buildConvContext("chat:1")).toBe("");
  });

  it("wraps turns in context block", () => {
    db.addConvTurn("chat:1", "user", "hello");
    db.addConvTurn("chat:1", "assistant", "world");
    const ctx = db.buildConvContext("chat:1");
    expect(ctx).toContain("[Context from previous conversation]");
    expect(ctx).toContain("User: hello");
    expect(ctx).toContain("Assistant: world");
    expect(ctx).toContain("[End context — continue naturally]");
  });

  it("includes summary above turns when one exists", () => {
    db.addConvTurn("chat:1", "user", "turn1");
    const [t1] = db.getRecentConvTurns("chat:1", 1);
    db.addConvSummary("chat:1", t1.id, t1.id, "## Summary\nObjective: fix bug");
    db.addConvTurn("chat:1", "assistant", "turn2");
    const ctx = db.buildConvContext("chat:1");
    expect(ctx).toContain("## Summary");
    expect(ctx).toContain("Assistant: turn2");
  });
});

describe("pending messages", () => {
  it("returns 0 when no pending messages", () => {
    expect(db.pendingMsgCount("chat:1")).toBe(0);
  });

  it("enqueues and dequeues a message", () => {
    db.enqueueMsg("chat:1", { prompt: "do work", chatId: 123, chatType: "private" });
    expect(db.pendingMsgCount("chat:1")).toBe(1);
    const msgs = db.dequeueMsgs("chat:1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].prompt).toBe("do work");
    expect(msgs[0].chatId).toBe(123);
  });

  it("deletePendingMsg removes the row", () => {
    db.enqueueMsg("chat:1", { prompt: "x", chatId: 1, chatType: "private" });
    const [msg] = db.dequeueMsgs("chat:1");
    db.deletePendingMsg(msg.id);
    expect(db.pendingMsgCount("chat:1")).toBe(0);
  });

  it("isolates queue by chatKey", () => {
    db.enqueueMsg("chat:1", { prompt: "a", chatId: 1, chatType: "private" });
    db.enqueueMsg("chat:2", { prompt: "b", chatId: 2, chatType: "private" });
    expect(db.pendingMsgCount("chat:1")).toBe(1);
    expect(db.pendingMsgCount("chat:2")).toBe(1);
  });
});

describe("conversation summaries", () => {
  it("getLatestConvSummary returns null when none exist", () => {
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
  });

  it("stores and retrieves a summary", () => {
    db.addConvTurn("chat:1", "user", "t1");
    const [t] = db.getRecentConvTurns("chat:1", 1);
    db.addConvSummary("chat:1", t.id, t.id, "## Summary\nObjective: build feature");
    const s = db.getLatestConvSummary("chat:1");
    expect(s).not.toBeNull();
    expect(s!.summary_md).toContain("build feature");
  });

  it("returns only the latest summary when multiple exist", () => {
    db.addConvTurn("chat:1", "user", "t1");
    const [t] = db.getRecentConvTurns("chat:1", 1);
    db.addConvSummary("chat:1", t.id, t.id, "first");
    db.addConvSummary("chat:1", t.id, t.id, "second");
    expect(db.getLatestConvSummary("chat:1")!.summary_md).toBe("second");
  });
});

describe("pruneConvTurns", () => {
  it("deletes turns up to and including the given id", () => {
    db.addConvTurn("chat:1", "user", "a");
    db.addConvTurn("chat:1", "assistant", "b");
    db.addConvTurn("chat:1", "user", "c");
    const all = db.getRecentConvTurns("chat:1", 10);
    expect(all.length).toBe(3);
    const cutoff = all[1].id; // prune first two turns
    db.pruneConvTurns("chat:1", cutoff);
    const remaining = db.getRecentConvTurns("chat:1", 10);
    expect(remaining.length).toBe(1);
    expect(remaining[0].text).toBe("c");
  });

  it("does not delete turns from other chat keys", () => {
    db.addConvTurn("chat:1", "user", "keep");
    db.addConvTurn("chat:2", "user", "prune me");
    const t2 = db.getRecentConvTurns("chat:2", 1)[0];
    db.pruneConvTurns("chat:2", t2.id);
    expect(db.getRecentConvTurns("chat:1", 10).length).toBe(1);
    expect(db.getRecentConvTurns("chat:2", 10).length).toBe(0);
  });

  it("is a no-op when id is below all stored turns", () => {
    db.addConvTurn("chat:1", "user", "x");
    db.pruneConvTurns("chat:1", 0);
    expect(db.getRecentConvTurns("chat:1", 10).length).toBe(1);
  });
});

describe("getConvStatus", () => {
  it("returns zeros and nulls for new chatKey", () => {
    const s = db.getConvStatus("chat:1");
    expect(s.turnCount).toBe(0);
    expect(s.pendingCount).toBe(0);
    expect(s.latestSummaryAt).toBeNull();
    expect(s.latestTurnAt).toBeNull();
  });

  it("reflects stored data", () => {
    db.addConvTurn("chat:1", "user", "hi");
    db.enqueueMsg("chat:1", { prompt: "q", chatId: 1, chatType: "private" });
    const s = db.getConvStatus("chat:1");
    expect(s.turnCount).toBe(1);
    expect(s.pendingCount).toBe(1);
    expect(s.latestTurnAt).not.toBeNull();
  });
});
