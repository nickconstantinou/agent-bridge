/**
 * Raw Discord WebSocket Gateway — heartbeat, identify, reconnect, resume.
 * Uses the Node.js 22+ native WebSocket global; no `ws` package required.
 *
 * Discord Gateway opcodes:
 *   0  DISPATCH          — event from server
 *   1  HEARTBEAT         — client sends heartbeat to server
 *   2  IDENTIFY          — authenticate new session
 *   6  RESUME            — resume an existing session
 *   7  RECONNECT         — server asks client to reconnect
 *   9  INVALID_SESSION   — session invalid; d=true means resumable
 *  10  HELLO             — first server message; carries heartbeat_interval
 *  11  HEARTBEAT_ACK     — server confirms heartbeat
 */

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_PRE_READY_CLOSES = 5;
const TERMINAL_CLOSE_CODES = new Set([
  4004, // Authentication failed
  4005, // Already authenticated
  4010, // Invalid shard
  4011, // Sharding required
  4013, // Invalid intents
  4014, // Disallowed intents
]);

export type GatewayPayload = {
  t: string | null;
  s: number | null;
  op: number;
  d: any;
};

export type GatewayEventHandler = (payload: GatewayPayload) => void;

export interface DiscordGatewayOptions {
  token: string;
  intents: number;
  onEvent: GatewayEventHandler;
  onReady?: () => void;
  onError?: (err: Error) => void;
}

export class DiscordGateway {
  private readonly opts: DiscordGatewayOptions;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatAckReceived = true;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private reconnectDelay = 1_000;
  private preReadyCloseCount = 0;
  private destroyed = false;
  private generation = 0;
  private closeHandled = false;

  constructor(opts: DiscordGatewayOptions) {
    this.opts = opts;
  }

  connect(): void {
    if (this.destroyed) return;
    const myGeneration = ++this.generation;
    this.closeHandled = false;
    const url = this.resumeGatewayUrl ?? GATEWAY_URL;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("message", ({ data }) => {
      if (myGeneration !== this.generation) return;
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(typeof data === "string" ? data : String(data));
      } catch {
        return;
      }
      this._handlePayload(payload);
    });

    ws.addEventListener("close", ({ code, reason }) => {
      if (myGeneration !== this.generation) return;
      this._handleClose(code, reason ?? "");
    });

    ws.addEventListener("error", (event) => {
      if (myGeneration !== this.generation) return;
      this.opts.onError?.(new Error(`WebSocket error: ${(event as any).message ?? "unknown"}`));
    });
  }

  private _handleClose(code: number, reason: string): void {
    if (this.closeHandled) return;
    this.closeHandled = true;
    this._stopHeartbeat();
    if (this.destroyed) return;
    if (TERMINAL_CLOSE_CODES.has(code)) {
      this.destroyed = true;
      this.opts.onError?.(new Error(`Discord Gateway terminal close code=${code} reason=${reason}`));
      return;
    }
    if (!this.sessionId) {
      this.preReadyCloseCount += 1;
      if (this.preReadyCloseCount >= MAX_PRE_READY_CLOSES) {
        this.destroyed = true;
        this.opts.onError?.(new Error(`Discord Gateway closed ${this.preReadyCloseCount} times before READY; stopping reconnects`));
        return;
      }
    }
    console.warn(`[discord-gateway] ws closed code=${code} reason=${reason}, reconnecting in ${this.reconnectDelay}ms`);
    this._scheduleReconnect();
  }

  destroy(): void {
    this.destroyed = true;
    this._stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  private _handlePayload(payload: GatewayPayload): void {
    if (payload.s != null) this.sequence = payload.s;

    switch (payload.op) {
      case 10: { // HELLO
        this._stopHeartbeat();
        this.heartbeatAckReceived = true;
        this._startHeartbeat(payload.d.heartbeat_interval as number);
        if (this.sessionId && this.resumeGatewayUrl) {
          this._sendResume();
        } else {
          this._sendIdentify();
        }
        break;
      }

      case 11: // HEARTBEAT_ACK
        this.heartbeatAckReceived = true;
        break;

      case 1: // HEARTBEAT requested by server
        this._sendHeartbeat();
        break;

      case 7: // RECONNECT
        console.log("[discord-gateway] server requested reconnect");
        this.ws?.close();
        this._handleClose(1000, "server requested reconnect");
        break;

      case 9: // INVALID_SESSION
        if (!payload.d) {
          // Not resumable — clear session state
          this.sessionId = null;
          this.resumeGatewayUrl = null;
          this.sequence = null;
        }
        // Wait 1–5s before reconnecting as Discord requires
        setTimeout(() => { if (!this.destroyed) this.connect(); }, 1_000 + Math.random() * 4_000);
        break;

      case 0: // DISPATCH
        if (payload.t === "READY") {
          this.sessionId = payload.d.session_id as string;
          this.resumeGatewayUrl = payload.d.resume_gateway_url as string;
          this.reconnectDelay = 1_000;
          this.preReadyCloseCount = 0;
          this.opts.onReady?.();
        }
        this.opts.onEvent(payload);
        break;
    }
  }

  private _sendIdentify(): void {
    this._send({
      op: 2,
      d: {
        token: this.opts.token,
        intents: this.opts.intents,
        properties: { os: "linux", browser: "agent-bridge", device: "agent-bridge" },
      },
    });
  }

  private _sendResume(): void {
    this._send({ op: 6, d: { token: this.opts.token, session_id: this.sessionId, seq: this.sequence } });
  }

  private _sendHeartbeat(): void {
    this._send({ op: 1, d: this.sequence });
    this.heartbeatAckReceived = false;
  }

  private _startHeartbeat(intervalMs: number): void {
    // Jitter first beat as recommended by Discord docs
    const jitter = Math.random() * intervalMs;
    this.heartbeatTimer = setTimeout(() => {
      this._sendHeartbeat();
      this.heartbeatInterval = setInterval(() => {
        if (!this.heartbeatAckReceived) {
          console.warn("[discord-gateway] no heartbeat ACK — zombie connection, reconnecting");
          this.ws?.close();
          return;
        }
        this._sendHeartbeat();
      }, intervalMs);
    }, jitter);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
  }

  private _scheduleReconnect(): void {
    setTimeout(() => { if (!this.destroyed) this.connect(); }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  private _send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }
}
