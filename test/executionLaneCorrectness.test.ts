import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, readFileSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";

function message(text: string, threadId: number) {
  return { message_id: Math.random(), chat: { id: 100, type: "private" }, from: { id: 42, first_name: "T" }, message_thread_id: threadId, text } as any;
}

function client() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }), sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn(), sendDocument: vi.fn(), getUpdates: vi.fn(), setMyCommands: vi.fn(), answerCallbackQuery: vi.fn(), editMessageText: vi.fn(),
  } as any;
}

function options(kind: "codex" | "claude", hooks: any = {}) {
  return { surfaceIdentity: "telegram:interactive", kind, botConfig: { command: kind, modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe" as const, asyncEnabled: false, pollIntervalMs: 1000, hooks };
}

describe("execution lane correctness", () => {
  it("claims FIFO queue rows only for the run that owns the lane and retains them until completion", () => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: "run-a" });
    expect(db.tryLock("telegram:interactive", "100:7")).toBe(true);
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "oldest", chatId: 100, threadId: 7, chatType: "private" });
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "newest", chatId: 100, threadId: 7, chatType: "private" });
    const first = db.claimNextPendingMsg("telegram:interactive", "100:7");
    expect(first?.prompt).toBe("oldest");
    expect(db.claimNextPendingMsg("telegram:interactive", "100:7")).toBeNull();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(2);
    expect(db.completePendingMsg(first!.id)).toBe(true);
    expect(db.claimNextPendingMsg("telegram:interactive", "100:7")?.prompt).toBe("newest");
    db.close();
  });

  it("recovers a claimed row after stale takeover instead of losing it", () => {
    const path = join(tmpdir(), `pending-claim-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const clock = () => now;
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "run-a", lockLeaseMs: 500, clock });
    runA.tryLock("telegram:interactive", "100:7");
    runA.enqueueMsg("telegram:interactive", "100:7", { prompt: "durable", chatId: 100, threadId: 7, chatType: "private" });
    expect(runA.claimNextPendingMsg("telegram:interactive", "100:7")?.prompt).toBe("durable");
    runA.close(); now += 501;
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "run-b", lockLeaseMs: 500, clock });
    expect(runB.tryLock("telegram:interactive", "100:7")).toBe(true);
    expect(runB.claimNextPendingMsg("telegram:interactive", "100:7")?.prompt).toBe("durable");
    runB.close(); rmSync(path, { force: true });
  });

  it("routes a claimed interactive message through the current provider while retaining lane ownership", async () => {
    const path = join(tmpdir(), `route-claim-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path, { serviceId: "telegram:interactive", runId: "live-run" });
    const c = client();
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const codexRun = vi.fn().mockImplementationOnce(() => first.then(() => "codex done"));
    const claudeRun = vi.fn().mockResolvedValue("claude done");
    let claude!: BridgeEngine;
    const codex = new BridgeEngine(options("codex", { onQueuedMessage: (queued: any) => claude.executeClaimedMessage(queued) }), db, c, { runCli: codexRun });
    claude = new BridgeEngine(options("claude"), db, c, { runCli: claudeRun });
    const active = codex.handleMessages([message("first", 7)]);
    await new Promise((r) => setTimeout(r, 20));
    await claude.handleMessages([message("queued for current Claude", 7)]);
    release(); await active;
    expect(codexRun).toHaveBeenCalledOnce();
    expect(claudeRun).toHaveBeenCalledOnce();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close(); rmSync(path, { force: true });
  });

  it("returns busy for /compact in an active topic lane while another topic remains independent", async () => {
    const path = join(tmpdir(), `compact-lane-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    const c = client();
    const engine = new BridgeEngine(options("claude"), db, c, { runCli: vi.fn().mockResolvedValue('{"summary_md":"topic eight summary","memory_candidates":[]}') });
    db.addConvTurn("100:7", "user", "topic seven"); db.addConvTurn("100:8", "user", "topic eight");
    db.tryLock("telegram:interactive", "100:7");
    await engine.handleMessages([message("/compact", 7)]);
    expect(c.sendMessage.mock.calls.some((call: any[]) => /busy|active/i.test(call[0].text))).toBe(true);
    await engine.handleMessages([message("/compact", 8)]);
    expect(db.getConvTurnsForCompaction("100:8")).toHaveLength(0);
    expect(db.getConvTurnsForCompaction("100:7")).toHaveLength(1);
    db.close(); rmSync(path, { force: true });
  });

  it("fences a displaced run before it publishes or commits conversation state", async () => {
    const path = join(tmpdir(), `fence-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    const c = client(); let resume!: (value: string) => void;
    const paused = new Promise<string>((resolve) => { resume = resolve; });
    const engineA = new BridgeEngine(options("claude"), runA, c, { runCli: () => paused });
    const active = engineA.handleMessages([message("old run", 7)]);
    await new Promise((r) => setTimeout(r, 20)); now += 101;
    expect(runB.tryLock("telegram:interactive", "100:7")).toBe(true);
    resume(JSON.stringify({ result: "stale output", session_id: "stale-session" })); await active;
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0].text === "stale output")).toBe(false);
    expect(runB.getSession("100:7", "claude")).toBeNull();
    expect(runB.ownsLock("telegram:interactive", "100:7")).toBe(true);
    runA.close(); runB.close(); rmSync(path, { force: true });
  });

  it("documents guarded rollout and quarantine", () => {
    const doc = readFileSync(join(process.cwd(), "docs", "execution-lane-rollout.md"), "utf8");
    expect(doc).toMatch(/stop-all.*migrate.*start-all/is);
    expect(doc).toMatch(/legacy queue count/i); expect(doc).toMatch(/explicit discard decision/i);
    expect(doc).toMatch(/flat private-chat history.*quarantin/is); expect(doc).toMatch(/separate approval/i);
    expect(doc).toMatch(/shared.*worktree.*concurrency/is);
  });
});
