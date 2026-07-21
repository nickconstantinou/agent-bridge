import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { runCli, shutdownCliProcessesAndWait } from "../src/cli.js";
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

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await shutdownCliProcessesAndWait();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("execution lane correctness", () => {
  it("fences delayed work from a previous acquisition by the same process run", () => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: "same-process" });
    const acquisitionA = db.acquireLock("telegram:interactive", "100:7");
    expect(acquisitionA).not.toBeNull();
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "claimed by A", chatId: 100, threadId: 7, chatType: "private" });
    const claimedByA = db.claimNextPendingMsg(acquisitionA!);
    expect(claimedByA?.prompt).toBe("claimed by A");

    expect(db.unlock(acquisitionA!)).toBe(true);
    const acquisitionB = db.acquireLock("telegram:interactive", "100:7");
    expect(acquisitionB).not.toBeNull();
    expect(acquisitionB!.acquisitionId).not.toBe(acquisitionA!.acquisitionId);

    expect(() => db.runWithLockFence(acquisitionA!, () => db.setSetting("stale-commit", "bad")))
      .toThrow("execution lock ownership lost");
    expect(db.completePendingMsg(acquisitionA!, claimedByA!.id)).toBe(false);
    expect(db.heartbeatLock(acquisitionA!)).toBe(false);
    expect(db.unlock(acquisitionA!)).toBe(false);
    expect(db.ownsLock(acquisitionB!)).toBe(true);

    db.runWithLockFence(acquisitionB!, () => db.setSetting("current-commit", "good"));
    expect(db.getSetting("stale-commit")).toBeNull();
    expect(db.getSetting("current-commit")).toBe("good");
    expect(db.unlock(acquisitionB!)).toBe(true);
    db.close();
  });

  it("claims FIFO queue rows only for the run that owns the lane and retains them until completion", () => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: "run-a" });
    const handle = db.acquireLock("telegram:interactive", "100:7")!;
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "oldest", chatId: 100, threadId: 7, chatType: "private" });
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "newest", chatId: 100, threadId: 7, chatType: "private" });
    const first = db.claimNextPendingMsg(handle);
    expect(first?.prompt).toBe("oldest");
    expect(db.claimNextPendingMsg(handle)).toBeNull();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(2);
    expect(db.unlockIfQueueEmpty(handle)).toBe(false);
    expect(db.completePendingMsg(handle, first!.id)).toBe(true);
    expect(db.claimNextPendingMsg(handle)?.prompt).toBe("newest");
    db.close();
  });

  it("recovers a claimed row after stale takeover instead of losing it", () => {
    const path = join(tmpdir(), `pending-claim-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const clock = () => now;
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "run-a", lockLeaseMs: 500, clock });
    const handleA = runA.acquireLock("telegram:interactive", "100:7")!;
    runA.enqueueMsg("telegram:interactive", "100:7", { prompt: "durable", chatId: 100, threadId: 7, chatType: "private" });
    const claimed = runA.claimNextPendingMsg(handleA);
    expect(claimed?.prompt).toBe("durable");
    const earlyRunB = openDb(path, { serviceId: "telegram:interactive", runId: "run-b", lockLeaseMs: 500, clock });
    expect(earlyRunB.completePendingMsg(handleA, claimed!.id)).toBe(false);
    earlyRunB.close(); runA.close(); now += 501;
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "run-b", lockLeaseMs: 500, clock });
    const handleB = runB.acquireLock("telegram:interactive", "100:7")!;
    expect(handleB).not.toBeNull();
    expect(runB.claimNextPendingMsg(handleB)?.prompt).toBe("durable");
    runB.close(); rmSync(path, { force: true });
  });

  it("routes a claimed interactive message through the current provider while retaining lane ownership", async () => {
    const path = join(tmpdir(), `route-claim-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path, { serviceId: "telegram:interactive", runId: "live-run" });
    const c = client();
    const codexRun = vi.fn().mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
      process.execPath,
      ["-e", "setTimeout(()=>console.log('codex done'),200)"],
      cwd,
      cliOptions,
    ));
    const claudeRun = vi.fn().mockResolvedValue("claude done");
    const fallbackChain = new WorkerFallbackChain(["codex", "claude"], db);
    const exhaustedChats = new Set<string>();
    const engines = {} as Record<string, BridgeEngine>;
    // This test is about durable FIFO routing across providers, not busy-mode
    // admission — pin busyMessageMode explicitly so a default flip elsewhere
    // can't change this test's meaning.
    const codex = new BridgeEngine({
      ...options("codex", {
        onQueuedMessage: (queued: any) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, {
          engines, fallbackChain, exhaustedChats, db, notify: vi.fn(),
        }),
      }),
      busyMessageMode: "queue",
    }, db, c, { runCli: codexRun });
    const claude = new BridgeEngine({ ...options("claude"), busyMessageMode: "queue" }, db, c, { runCli: claudeRun });
    engines.codex = codex; engines.claude = claude;
    const active = codex.handleMessages([message("first", 7)]);
    await new Promise((r) => setTimeout(r, 20));
    setUserCliPreference(db, "100:7", "claude");
    await claude.handleMessages([message("queued for current Claude", 7)]);
    await active;
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
    db.acquireLock("telegram:interactive", "100:7");
    await engine.handleMessages([message("/compact", 7)]);
    expect(c.sendMessage.mock.calls.some((call: any[]) => /busy|active/i.test(call[0].text))).toBe(true);
    await engine.handleMessages([message("/compact", 8)]);
    expect(db.getConvTurnsForCompaction("100:8")).toHaveLength(0);
    expect(db.getConvTurnsForCompaction("100:7")).toHaveLength(1);
    expect(db.getConvTurnsForCompaction("100").map((turn) => turn.text)).toEqual(["quarantined flat history"]);
    db.close(); rmSync(path, { force: true });
  });

  it("runs /btw as a fresh tool-free side invocation without the main lane or session", async () => {
    const path = join(tmpdir(), `btw-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    const c = client();
    const runCli = vi.fn().mockResolvedValue('{"result":"side answer","session_id":"side-session"}');
    const engine = new BridgeEngine(options("claude"), db, c, { runCli });

    await engine.handleMessages([message("/btw inspect the repository without changing it", 7)]);

    expect(runCli).toHaveBeenCalledOnce();
    const [, args, , cliOptions] = runCli.mock.calls[0];
    expect(args).toContain("--print");
    expect(args).toContain("--tools");
    expect(args).toContain("");
    expect(args).not.toContain("--resume");
    expect(cliOptions.bypassWorkspaceLock).toBe(true);
    expect(String(cliOptions.chatId)).toMatch(/btw/);
    expect(db.getSession("100:7", "claude")).toBeNull();
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0].text === "side answer")).toBe(true);

    db.close(); rmSync(path, { force: true });
  });

  it("keeps the lane owned until a TERM-resistant child exits after SIGKILL", async () => {
    const path = join(tmpdir(), `stop-grace-${Date.now()}-${Math.random()}.sqlite`);
    const childReady = join(tmpdir(), `stop-grace-ready-${Date.now()}-${Math.random()}`);
    const db = openDb(path);
    const c = client();
    const engine = new BridgeEngine(options("claude"), db, c, {
      runCli: (_command, _args, cwd, cliOptions) => runCli(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", childReady],
        cwd,
        cliOptions,
      ),
    });
    const active = engine.handleMessages([message("long run", 7)]);
    await waitForFile(childReady);
    const stopping = engine.handleUpdate({ update_id: 2, message: message("/stop", 7) });
    await new Promise((r) => setTimeout(r, 100));
    expect(db.acquireLock("telegram:interactive", "100:7")).toBeNull();
    await stopping; await active;
    expect(db.acquireLock("telegram:interactive", "100:7")).not.toBeNull();
    db.close(); rmSync(path, { force: true }); rmSync(childReady, { force: true });
  }, 8_000);

  it("keeps the lane owned during /reset until a TERM-resistant child exits after SIGKILL", async () => {
    const path = join(tmpdir(), `reset-grace-${Date.now()}-${Math.random()}.sqlite`);
    const childReady = join(tmpdir(), `reset-grace-ready-${Date.now()}-${Math.random()}`);
    const db = openDb(path);
    const c = client();
    const engine = new BridgeEngine(options("claude"), db, c, {
      runCli: (_command, _args, cwd, cliOptions) => runCli(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", childReady],
        cwd,
        cliOptions,
      ),
    });
    const active = engine.handleMessages([message("long reset run", 7)]);
    await waitForFile(childReady);
    const resetting = engine.handleMessages([message("/reset", 7)]);
    await new Promise((r) => setTimeout(r, 100));
    expect(db.acquireLock("telegram:interactive", "100:7")).toBeNull();
    await resetting; await active;
    expect(db.acquireLock("telegram:interactive", "100:7")).not.toBeNull();
    db.close(); rmSync(path, { force: true }); rmSync(childReady, { force: true });
  }, 8_000);

  it("interrupt mode aborts the active turn and admits the next message immediately instead of waiting in FIFO (Issue #177)", async () => {
    const path = join(tmpdir(), `interrupt-${Date.now()}-${Math.random()}.sqlite`);
    const childReady = join(tmpdir(), `interrupt-ready-${Date.now()}-${Math.random()}`);
    const db = openDb(path);
    const c = client();
    const secondTurnRun = vi.fn().mockResolvedValue('{"result":"second turn done","session_id":"s2"}');
    const engine = new BridgeEngine({ ...options("claude"), busyMessageMode: "interrupt" }, db, c, {
      runCli: vi.fn()
        .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
          process.execPath,
          ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", childReady],
          cwd,
          cliOptions,
        ))
        .mockImplementationOnce(secondTurnRun),
    });
    const startedAt = Date.now();
    const first = engine.handleMessages([message("long first turn", 7)]);
    await waitForFile(childReady);
    const second = engine.handleMessages([message("interrupt with this", 7)]);
    await Promise.all([first, second]);
    const elapsedMs = Date.now() - startedAt;

    // Proves the second turn did not wait for the first turn's natural 10s completion.
    // The child honours SIGTERM (no ignore handler), so abort should land in well under 1s.
    expect(elapsedMs).toBeLessThan(3_000);
    expect(secondTurnRun).toHaveBeenCalledOnce();
    // The killed first turn must never commit a session — only the second turn's session lands.
    expect(db.getSession("100:7", "claude")).toBe("s2");
    // Exactly one assistant reply was delivered (the second turn's) — the interrupted
    // first turn must not send a committed final response.
    const finalReplies = c.sendMessage.mock.calls.filter((call: any[]) => call[0].text === "second turn done");
    expect(finalReplies).toHaveLength(1);
    expect(db.acquireLock("telegram:interactive", "100:7")).not.toBeNull();
    db.close(); rmSync(path, { force: true }); rmSync(childReady, { force: true });
  }, 8_000);

  it("a configured hard timeout follows the /stop cancellation path — discards queued work, preserves last committed session (Issue #177)", async () => {
    const path = join(tmpdir(), `timeout-cancel-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    const c = client();
    const savedTimeout = process.env.CLAUDE_CLI_TIMEOUT_MS;
    const savedIdle = process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS;
    process.env.CLAUDE_CLI_TIMEOUT_MS = "300";
    process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS = "0";
    const secondRun = vi.fn().mockResolvedValue("should never run");
    const engine = new BridgeEngine({ ...options("claude"), busyMessageMode: "queue" }, db, c, {
      runCli: vi.fn()
        .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
          process.execPath,
          ["-e", "setTimeout(()=>{},10000)"],
          cwd,
          cliOptions,
        ))
        .mockImplementationOnce(secondRun),
    });
    try {
      const first = engine.handleMessages([message("times out", 7)]);
      await new Promise((r) => setTimeout(r, 50));
      const second = engine.handleMessages([message("queued behind the timeout", 7)]);
      await Promise.all([first, second]);

      // The queued message must be discarded, not executed — same as /stop.
      expect(secondRun).not.toHaveBeenCalled();
      expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
      // No session was committed by the timed-out turn.
      expect(db.getSession("100:7", "claude")).toBeNull();
      // The lane is released, not stuck.
      expect(db.acquireLock("telegram:interactive", "100:7")).not.toBeNull();
    } finally {
      if (savedTimeout === undefined) delete process.env.CLAUDE_CLI_TIMEOUT_MS; else process.env.CLAUDE_CLI_TIMEOUT_MS = savedTimeout;
      if (savedIdle === undefined) delete process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS; else process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS = savedIdle;
      db.close(); rmSync(path, { force: true });
    }
  }, 8_000);

  it("queue mode (explicit) still waits for the active turn's natural completion before running the next message", async () => {
    const path = join(tmpdir(), `queue-mode-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    const c = client();
    const codexRun = vi.fn().mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
      process.execPath,
      ["-e", "setTimeout(()=>console.log('first done'),150)"],
      cwd,
      cliOptions,
    ));
    const secondRun = vi.fn().mockResolvedValue("second done");
    const engine = new BridgeEngine({ ...options("claude"), busyMessageMode: "queue" }, db, c, {
      runCli: vi.fn().mockImplementationOnce(codexRun).mockImplementationOnce(secondRun),
    });
    const first = engine.handleMessages([message("first", 7)]);
    await new Promise((r) => setTimeout(r, 20));
    const second = engine.handleMessages([message("second", 7)]);
    await Promise.all([first, second]);
    expect(codexRun).toHaveBeenCalledOnce();
    expect(secondRun).toHaveBeenCalledOnce();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close(); rmSync(path, { force: true });
  });

  it("keeps /reset fenced through delayed finalisation before allowing a new acquisition", async () => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: "same-process" });
    const c = client();
    let resumeFinalisation!: () => void;
    const delayedFinalisation = new Promise<void>((resolve) => { resumeFinalisation = resolve; });
    let hookCalls = 0;
    const runCli = vi.fn().mockResolvedValueOnce("old result").mockResolvedValueOnce("new result");
    const engine = new BridgeEngine(options("claude", {
      onAfterExecute: async () => {
        hookCalls += 1;
        if (hookCalls === 1) await delayedFinalisation;
      },
    }), db, c, { runCli });

    const oldRun = engine.handleMessages([message("old request", 7)]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const reset = engine.handleMessages([message("/reset", 7)]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(db.acquireLock("telegram:interactive", "100:7")).toBeNull();

    resumeFinalisation();
    await oldRun;
    await reset;
    await engine.handleMessages([message("new request", 7)]);

    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0].text === "old result")).toBe(false);
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0].text === "new result")).toBe(true);
    expect(db.getSession("100:7", "claude")).not.toBe("old result");
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close();
  });

  it("does not let a displaced run delete its claimed row before the successor reclaims it", () => {
    const path = join(tmpdir(), `claim-fence-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    const handleA = runA.acquireLock("telegram:interactive", "100:7")!;
    runA.enqueueMsg("telegram:interactive", "100:7", { prompt: "must survive", chatId: 100, threadId: 7, chatType: "private" });
    const claimed = runA.claimNextPendingMsg(handleA)!;
    now += 101;
    const handleB = runB.acquireLock("telegram:interactive", "100:7")!;
    expect(handleB).not.toBeNull();
    expect(runA.completePendingMsg(handleA, claimed.id)).toBe(false);
    expect(runB.pendingMsgCount("telegram:interactive", "100:7")).toBe(1);
    expect(runB.claimNextPendingMsg(handleB)?.prompt).toBe("must survive");
    runA.close(); runB.close(); rmSync(path, { force: true });
  });

  it("returns a fenced queued outcome and preserves the row until successor recovery", async () => {
    const path = join(tmpdir(), `queued-outcome-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    const handleA = runA.acquireLock("telegram:interactive", "100:7")!;
    runA.enqueueMsg("telegram:interactive", "100:7", { prompt: "claimed work", chatId: 100, threadId: 7, chatType: "private" });
    const claimed = runA.claimNextPendingMsg(handleA)!;
    let resume!: (value: string) => void;
    const paused = new Promise<string>((resolve) => { resume = resolve; });
    const engine = new BridgeEngine(options("claude"), runA, client(), { runCli: () => paused });
    const execution = engine.executeClaimedMessage({ ...claimed, laneHandle: handleA });
    await new Promise((r) => setTimeout(r, 20)); now += 101;
    expect(runB.acquireLock("telegram:interactive", "100:7")).not.toBeNull();
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
    db.setSetting("ctx_suppress:100:7", "1");
    db.enqueueMsg("telegram:interactive", "100:7", {
      prompt: "oldest after restart", chatId: 100, threadId: 7, chatType: "private", attachments: [attachment],
    });
    const seen: Array<{ prompt: string; hasAttachment: boolean }> = [];
    const engine = new BridgeEngine(options("claude"), db, client(), {
      runCli: vi.fn().mockImplementation(async (_command: string, args: string[], _cwd: string, cliOptions: any) => {
        const prompt = `${args.join(" ")} ${cliOptions?.stdin ?? ""}`;
        seen.push({ prompt, hasAttachment: prompt.includes("ZHVyYWJsZSBhdHRhY2htZW50") });
        return "ok";
      }),
    });
    await engine.handleMessages([message("new arrival", 7)]);
    expect(seen.map((entry) => entry.prompt.includes("oldest after restart") ? "oldest" : "new")).toEqual(["oldest", "new"]);
    expect(seen[0].hasAttachment).toBe(true);
    expect(existsSync(attachment)).toBe(false);
    db.close(); rmSync(path, { force: true }); rmSync(attachment, { force: true });
  });

  it("persists a downloaded busy-lane attachment and delivers it after the lane becomes free", async () => {
    const path = join(tmpdir(), `busy-attachment-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    db.setSetting("ctx_suppress:100:7", "1");
    const blockingHandle = db.acquireLock("telegram:interactive", "100:7")!;
    const c = client();
    c.getFilePath = vi.fn().mockResolvedValue("documents/queued.txt");
    c.downloadFile = vi.fn().mockImplementation(async (_remote: string, destination: string) => {
      writeFileSync(destination, "queued document payload");
    });
    let cliInput = "";
    const runCli = vi.fn().mockImplementation(async (_command: string, args: string[], _cwd: string, cliOptions: any) => {
      cliInput = `${args.join(" ")} ${cliOptions?.stdin ?? ""}`;
      return "processed attachment";
    });
    const engine = new BridgeEngine(options("claude"), db, c, { runCli });
    const attached = message("inspect this document", 7);
    attached.document = { file_id: "queued-file", file_name: "queued.txt", mime_type: "text/plain", file_size: 23 };

    await engine.handleMessages([attached]);
    const queued = db.dequeueMsgs("telegram:interactive", "100:7");
    expect(queued).toHaveLength(1);
    expect(queued[0].attachments).toHaveLength(1);
    const queuedPath = queued[0].attachments[0];
    expect(existsSync(queuedPath)).toBe(true);
    expect(runCli).not.toHaveBeenCalled();

    db.unlock(blockingHandle);
    await engine.recoverPendingQueues();
    expect(runCli).toHaveBeenCalledOnce();
    expect(cliInput).toContain(Buffer.from("queued document payload").toString("base64"));
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    expect(existsSync(queuedPath)).toBe(false);
    db.close(); rmSync(path, { force: true });
  });

  it("retries the oldest row before later arrivals after a queue handoff failure", async () => {
    const path = join(tmpdir(), `handoff-retry-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    db.setSetting("ctx_suppress:100:7", "1");
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "oldest", chatId: 100, threadId: 7, chatType: "private" });
    const order: string[] = [];
    let failOnce = true;
    let engine!: BridgeEngine;
    engine = new BridgeEngine(options("claude", {
      onQueuedMessage: async (queued: any) => {
        if (failOnce) { failOnce = false; throw new Error("router unavailable"); }
        return engine.executeClaimedMessage(queued);
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

  it("automatically resumes durable queued work on startup without a new message", async () => {
    const path = join(tmpdir(), `startup-recovery-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    db.setSetting("ctx_suppress:100:7", "1");
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "recover on startup", chatId: 100, threadId: 7, chatType: "private" });
    const runCli = vi.fn().mockResolvedValue("recovered");
    const engine = new BridgeEngine(options("claude"), db, client(), { runCli });
    await engine.recoverPendingQueues();
    expect(runCli).toHaveBeenCalledOnce();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close(); rmSync(path, { force: true });
  });

  it("automatically retries a transient queue-router failure without a new message", async () => {
    const path = join(tmpdir(), `router-retry-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    db.setSetting("ctx_suppress:100:7", "1");
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "retry automatically", chatId: 100, threadId: 7, chatType: "private" });
    const runCli = vi.fn().mockResolvedValue("recovered");
    let failOnce = true;
    let engine!: BridgeEngine;
    engine = new BridgeEngine(options("claude", {
      onQueuedMessage: async (queued: any) => {
        if (failOnce) { failOnce = false; throw new Error("transient router failure"); }
        return engine.executeClaimedMessage(queued);
      },
    }), db, client(), { runCli });
    await engine.recoverPendingQueues();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(runCli).toHaveBeenCalledOnce();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close(); rmSync(path, { force: true });
  });

  it("renews and fences atomically after parsing before the first state mutation", async () => {
    const path = join(tmpdir(), `commit-fence-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    const c = client();
    const original = (runA as any).runWithLockFence?.bind(runA);
    (runA as any).runWithLockFence = (handle: any, operation: () => unknown) => {
      now += 101;
      expect(runB.acquireLock(handle.surface, handle.chatKey)).not.toBeNull();
      return original(handle, operation);
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
    (runA as any).runWithLockFence = (handle: any, operation: () => unknown) => {
      now += 101;
      expect(runB.acquireLock(handle.surface, handle.chatKey)).not.toBeNull();
      return original(handle, operation);
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
    const handleB = runB.acquireLock("telegram:interactive", "100:7")!;
    expect(handleB).not.toBeNull();
    resume(JSON.stringify({ result: "stale output", session_id: "stale-session" })); await active;
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0].text === "stale output")).toBe(false);
    expect(runB.getSession("100:7", "claude")).toBeNull();
    expect(runB.ownsLock(handleB)).toBe(true);
    runA.close(); runB.close(); rmSync(path, { force: true });
  });

  it("documents guarded rollout and quarantine", () => {
    const doc = readFileSync(join(process.cwd(), "docs", "execution-lane-rollout.md"), "utf8");
    expect(doc).toMatch(/stop-all.*migrate.*start-all/is);
    expect(doc).toMatch(/legacy queue count/i); expect(doc).toMatch(/explicit discard decision/i);
    expect(doc).toMatch(/flat private-chat history.*quarantin/is); expect(doc).toMatch(/separate approval/i);
    expect(doc).toMatch(/BRIDGE_WORKSPACE_LOCK_MODE=off/is);
    expect(doc).toMatch(/isolated per-job worktrees/is);
  });
});
