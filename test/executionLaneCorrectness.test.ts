import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { runCli } from "../src/cli.js";
import { dispatchClaimedInteractiveWithFallback, setUserCliPreference } from "../src/interactiveBot.js";
import { WorkerFallbackChain } from "../src/workerFallback.js";

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
    expect(db.unlockIfQueueEmpty("telegram:interactive", "100:7")).toBe(false);
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
    const claimed = runA.claimNextPendingMsg("telegram:interactive", "100:7");
    expect(claimed?.prompt).toBe("durable");
    const earlyRunB = openDb(path, { serviceId: "telegram:interactive", runId: "run-b", lockLeaseMs: 500, clock });
    expect(earlyRunB.completePendingMsg(claimed!.id)).toBe(false);
    earlyRunB.close(); runA.close(); now += 501;
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
    const fallbackChain = new WorkerFallbackChain(["codex", "claude"], db);
    const exhaustedChats = new Set<string>();
    const engines = {} as Record<string, BridgeEngine>;
    const codex = new BridgeEngine(options("codex", {
      onQueuedMessage: (queued: any) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, {
        engines, fallbackChain, exhaustedChats, db, notify: vi.fn(),
      }),
    }), db, c, { runCli: codexRun });
    const claude = new BridgeEngine(options("claude"), db, c, { runCli: claudeRun });
    engines.codex = codex; engines.claude = claude;
    const active = codex.handleMessages([message("first", 7)]);
    await new Promise((r) => setTimeout(r, 20));
    setUserCliPreference(db, "100:7", "claude");
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
    db.addConvTurn("100", "user", "quarantined flat history");
    db.addConvTurn("100:7", "user", "topic seven"); db.addConvTurn("100:8", "user", "topic eight");
    db.tryLock("telegram:interactive", "100:7");
    await engine.handleMessages([message("/compact", 7)]);
    expect(c.sendMessage.mock.calls.some((call: any[]) => /busy|active/i.test(call[0].text))).toBe(true);
    await engine.handleMessages([message("/compact", 8)]);
    expect(db.getConvTurnsForCompaction("100:8")).toHaveLength(0);
    expect(db.getConvTurnsForCompaction("100:7")).toHaveLength(1);
    expect(db.getConvTurnsForCompaction("100").map((turn) => turn.text)).toEqual(["quarantined flat history"]);
    db.close(); rmSync(path, { force: true });
  });

  it("keeps the lane owned until a TERM-resistant child exits after SIGKILL", async () => {
    const path = join(tmpdir(), `stop-grace-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    const c = client();
    const engine = new BridgeEngine(options("claude"), db, c, {
      runCli: (_command, _args, cwd, cliOptions) => runCli(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); setTimeout(()=>{},10000)"],
        cwd,
        cliOptions,
      ),
    });
    const active = engine.handleMessages([message("long run", 7)]);
    await new Promise((r) => setTimeout(r, 150));
    const stopping = engine.handleUpdate({ update_id: 2, message: message("/stop", 7) });
    await new Promise((r) => setTimeout(r, 100));
    expect(db.tryLock("telegram:interactive", "100:7")).toBe(false);
    await stopping; await active;
    expect(db.tryLock("telegram:interactive", "100:7")).toBe(true);
    db.close(); rmSync(path, { force: true });
  }, 8_000);

  it("keeps the lane owned during /reset until a TERM-resistant child exits after SIGKILL", async () => {
    const path = join(tmpdir(), `reset-grace-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    const c = client();
    const engine = new BridgeEngine(options("claude"), db, c, {
      runCli: (_command, _args, cwd, cliOptions) => runCli(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); setTimeout(()=>{},10000)"],
        cwd,
        cliOptions,
      ),
    });
    const active = engine.handleMessages([message("long reset run", 7)]);
    await new Promise((r) => setTimeout(r, 150));
    const resetting = engine.handleMessages([message("/reset", 7)]);
    await new Promise((r) => setTimeout(r, 100));
    expect(db.tryLock("telegram:interactive", "100:7")).toBe(false);
    await resetting; await active;
    expect(db.tryLock("telegram:interactive", "100:7")).toBe(true);
    db.close(); rmSync(path, { force: true });
  }, 8_000);

  it("does not let a displaced run delete its claimed row before the successor reclaims it", () => {
    const path = join(tmpdir(), `claim-fence-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    runA.tryLock("telegram:interactive", "100:7");
    runA.enqueueMsg("telegram:interactive", "100:7", { prompt: "must survive", chatId: 100, threadId: 7, chatType: "private" });
    const claimed = runA.claimNextPendingMsg("telegram:interactive", "100:7")!;
    now += 101;
    expect(runB.tryLock("telegram:interactive", "100:7")).toBe(true);
    expect(runA.completePendingMsg(claimed.id)).toBe(false);
    expect(runB.pendingMsgCount("telegram:interactive", "100:7")).toBe(1);
    expect(runB.claimNextPendingMsg("telegram:interactive", "100:7")?.prompt).toBe("must survive");
    runA.close(); runB.close(); rmSync(path, { force: true });
  });

  it("returns a fenced queued outcome and preserves the row until successor recovery", async () => {
    const path = join(tmpdir(), `queued-outcome-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    runA.tryLock("telegram:interactive", "100:7");
    runA.enqueueMsg("telegram:interactive", "100:7", { prompt: "claimed work", chatId: 100, threadId: 7, chatType: "private" });
    const claimed = runA.claimNextPendingMsg("telegram:interactive", "100:7")!;
    let resume!: (value: string) => void;
    const paused = new Promise<string>((resolve) => { resume = resolve; });
    const engine = new BridgeEngine(options("claude"), runA, client(), { runCli: () => paused });
    const execution = engine.executeClaimedMessage(claimed);
    await new Promise((r) => setTimeout(r, 20)); now += 101;
    expect(runB.tryLock("telegram:interactive", "100:7")).toBe(true);
    resume(JSON.stringify({ result: "stale", session_id: "stale" }));
    await expect(execution).resolves.toBe("fenced");
    expect(runB.pendingMsgCount("telegram:interactive", "100:7")).toBe(1);
    runA.close(); runB.close(); rmSync(path, { force: true });
  });

  it("executes a recovered durable row before a new arrival and preserves its attachment", async () => {
    const path = join(tmpdir(), `restart-fifo-${Date.now()}-${Math.random()}.sqlite`);
    const attachment = join(tmpdir(), `queued-attachment-${Date.now()}.txt`);
    writeFileSync(attachment, "durable attachment");
    const db = openDb(path);
    db.enqueueMsg("telegram:interactive", "100:7", {
      prompt: "oldest after restart", chatId: 100, threadId: 7, chatType: "private", attachments: [attachment],
    });
    const seen: Array<{ prompt: string; hasAttachment: boolean }> = [];
    const engine = new BridgeEngine(options("claude"), db, client(), {
      runCli: vi.fn().mockImplementation(async (_command: string, args: string[]) => {
        const prompt = String(args.at(-1));
        seen.push({ prompt, hasAttachment: prompt.includes(attachment) });
        return "ok";
      }),
    });
    await engine.handleMessages([message("new arrival", 7)]);
    expect(seen.map((entry) => entry.prompt.includes("oldest after restart") ? "oldest" : "new")).toEqual(["oldest", "new"]);
    expect(seen[0].hasAttachment).toBe(true);
    expect(existsSync(attachment)).toBe(false);
    db.close(); rmSync(path, { force: true }); rmSync(attachment, { force: true });
  });

  it("retries the oldest row before later arrivals after a queue handoff failure", async () => {
    const path = join(tmpdir(), `handoff-retry-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "oldest", chatId: 100, threadId: 7, chatType: "private" });
    const order: string[] = [];
    let failOnce = true;
    let engine!: BridgeEngine;
    engine = new BridgeEngine(options("claude", {
      onQueuedMessage: async (queued: any) => {
        if (failOnce) { failOnce = false; throw new Error("router unavailable"); }
        await engine.executeClaimedMessage(queued);
      },
    }), db, client(), {
      runCli: vi.fn().mockImplementation(async (_command: string, args: string[]) => {
        const prompt = String(args.at(-1));
        order.push(prompt.includes("oldest") ? "oldest" : prompt.includes("arrival one") ? "one" : "two");
        return "ok";
      }),
    });
    await engine.handleMessages([message("arrival one", 7)]);
    expect(order).toEqual([]);
    await engine.handleMessages([message("arrival two", 7)]);
    expect(order).toEqual(["oldest", "one", "two"]);
    db.close(); rmSync(path, { force: true });
  });

  it("renews and fences atomically after parsing before the first state mutation", async () => {
    const path = join(tmpdir(), `commit-fence-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    const c = client();
    const original = (runA as any).runWithLockFence?.bind(runA);
    (runA as any).runWithLockFence = (surface: string, chatKey: string, operation: () => unknown) => {
      now += 101;
      expect(runB.tryLock(surface, chatKey)).toBe(true);
      return original(surface, chatKey, operation);
    };
    const engine = new BridgeEngine(options("claude"), runA, c, {
      runCli: vi.fn().mockResolvedValue(JSON.stringify({ result: "parsed but fenced", session_id: "must-not-store" })),
    });
    await engine.handleMessages([message("race commit", 7)]);
    expect(runB.getSession("100:7", "claude")).toBeNull();
    expect(runB.getConvTurnsForCompaction("100:7")).toHaveLength(0);
    expect(c.sendMessage.mock.calls.some((call: any[]) => String(call[0].text).includes("parsed but fenced"))).toBe(false);
    runA.close(); runB.close(); rmSync(path, { force: true });
  });

  it("fences post-compaction session reset and success notification", async () => {
    const path = join(tmpdir(), `compact-publish-fence-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    runA.addConvTurn("100:7", "user", "compact me");
    runA.setSession("100:7", "claude", "keep-on-fence");
    const c = client();
    const original = (runA as any).runWithLockFence?.bind(runA);
    (runA as any).runWithLockFence = (surface: string, chatKey: string, operation: () => unknown) => {
      now += 101;
      expect(runB.tryLock(surface, chatKey)).toBe(true);
      return original(surface, chatKey, operation);
    };
    const engine = new BridgeEngine(options("claude"), runA, c, {
      runCli: vi.fn().mockResolvedValue('{"summary_md":"safe summary","memory_candidates":[]}'),
    });
    await expect(engine.handleMessages([message("/compact", 7)])).rejects.toThrow();
    expect(runB.getSession("100:7", "claude")).toBe("keep-on-fence");
    expect(c.sendMessage.mock.calls.some((call: any[]) => String(call[0].text).includes("Context compacted"))).toBe(false);
    runA.close(); runB.close(); rmSync(path, { force: true });
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
