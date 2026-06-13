import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DiscordGateway } from "../src/discord-gateway.js";

/**
 * Minimal WebSocket stub that captures send calls and lets tests drive events.
 */
class FakeWebSocket {
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  readonly listeners: Record<string, ((...args: any[]) => void)[]> = {};
  readonly sent: any[] = [];

  addEventListener(event: string, fn: (...args: any[]) => void) {
    this.listeners[event] ??= [];
    this.listeners[event].push(fn);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.emit("close", { code: 1000, reason: "test" });
  }

  emit(event: string, ...args: any[]) {
    for (const fn of this.listeners[event] ?? []) fn(...args);
  }

  emitMessage(payload: object) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
}

function makeGateway(onEvent = vi.fn(), onReady = vi.fn()) {
  const gateway = new DiscordGateway({
    token: "test-token",
    intents: 33_281,
    onEvent,
    onReady,
  });
  return gateway;
}

describe("DiscordGateway", () => {
  let origWebSocket: typeof WebSocket;
  let fakeWs: FakeWebSocket;

  beforeEach(() => {
    fakeWs = new FakeWebSocket();
    origWebSocket = (globalThis as any).WebSocket;
    // Must be a regular function (not arrow) to be `new`-able
    (globalThis as any).WebSocket = function FakeWsConstructor() { return fakeWs; };
    (globalThis as any).WebSocket.OPEN = FakeWebSocket.OPEN;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = origWebSocket;
    vi.useRealTimers();
  });

  it("sends IDENTIFY after receiving HELLO", () => {
    vi.useFakeTimers();
    const gateway = makeGateway();
    gateway.connect();

    fakeWs.emitMessage({ op: 10, d: { heartbeat_interval: 41_250 }, t: null, s: null });

    // Advance past jitter (max = heartbeat_interval = 41250ms) to trigger first heartbeat + IDENTIFY
    vi.advanceTimersByTime(42_000);
    // Simulate ACK so the next interval doesn't close the connection
    fakeWs.emitMessage({ op: 11, d: null, t: null, s: null });

    const identify = fakeWs.sent.find((p) => p.op === 2);
    expect(identify).toBeDefined();
    expect(identify.d.token).toBe("test-token");

    gateway.destroy();
  });

  it("sends heartbeat at the specified interval after HELLO", () => {
    vi.useFakeTimers();
    const gateway = makeGateway();
    gateway.connect();

    fakeWs.emitMessage({ op: 10, d: { heartbeat_interval: 10_000 }, t: null, s: null });

    // First heartbeat fires after jitter (≤10000ms)
    vi.advanceTimersByTime(10_001);

    const heartbeats = fakeWs.sent.filter((p) => p.op === 1);
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    gateway.destroy();
  });

  it("calls onReady and onEvent when READY dispatch arrives", () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const onEvent = vi.fn();
    const gateway = makeGateway(onEvent, onReady);
    gateway.connect();

    // Use a long interval so the heartbeat zombie check doesn't fire in this test
    fakeWs.emitMessage({ op: 10, d: { heartbeat_interval: 300_000 }, t: null, s: null });
    // Only advance past jitter, not the full interval
    vi.advanceTimersByTime(300_001);
    // ACK the first heartbeat so zombie guard is satisfied
    fakeWs.emitMessage({ op: 11, d: null, t: null, s: null });

    fakeWs.emitMessage({
      op: 0,
      t: "READY",
      s: 1,
      d: { session_id: "sess-abc", resume_gateway_url: "wss://gateway.discord.gg/resume" },
    });

    expect(onReady).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ t: "READY" }));

    gateway.destroy();
  });

  it("forwards MESSAGE_CREATE dispatch to onEvent", () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const gateway = makeGateway(onEvent);
    gateway.connect();

    fakeWs.emitMessage({ op: 10, d: { heartbeat_interval: 300_000 }, t: null, s: null });
    vi.advanceTimersByTime(300_001);
    fakeWs.emitMessage({ op: 11, d: null, t: null, s: null });

    fakeWs.emitMessage({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { content: "hello", channel_id: "ch-1" } });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ t: "MESSAGE_CREATE" }));

    gateway.destroy();
  });

  it("tracks sequence numbers from DISPATCH events", () => {
    vi.useFakeTimers();
    const gateway = makeGateway();
    gateway.connect();

    // HELLO → starts heartbeat with 1000ms interval
    fakeWs.emitMessage({ op: 10, d: { heartbeat_interval: 1_000 }, t: null, s: null });

    // Advance past jitter (≤1000ms) so IDENTIFY is sent and interval starts
    vi.advanceTimersByTime(1_001);

    // Receive READY (seq 5) and a message (seq 7) — updates internal sequence
    fakeWs.emitMessage({ op: 0, t: "READY", s: 5, d: { session_id: "s", resume_gateway_url: "wss://r" } });
    fakeWs.emitMessage({ op: 0, t: "MESSAGE_CREATE", s: 7, d: {} });
    // Simulate ACK so heartbeat guard passes
    fakeWs.emitMessage({ op: 11, d: null, t: null, s: null });

    // Advance past one full interval — triggers heartbeat carrying seq 7
    vi.advanceTimersByTime(1_001);

    const heartbeats = fakeWs.sent.filter((p) => p.op === 1);
    const last = heartbeats.at(-1);
    expect(last?.d).toBe(7);

    gateway.destroy();
  });
});
