import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import type { BridgeConfig, TelegramMessage } from "../src/types.js";

const message = (text: string): TelegramMessage => ({
  message_id: 77, chat: { id: 100, type: "private" }, from: { id: 42, first_name: "Test" }, text,
});
const client = () => ({
  getUpdates: vi.fn(), sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
  sendChatAction: vi.fn().mockResolvedValue({ ok: true }), setMyCommands: vi.fn(),
  answerCallbackQuery: vi.fn(), editMessageText: vi.fn(), sendPhoto: vi.fn(), sendDocument: vi.fn(),
}) as any;
const config = (): BridgeConfig => ({
  allowedUserIds: new Set(["42"]), serviceEnvFile: null, serviceKind: null, pollIntervalMs: 1000,
  executionMode: "safe", asyncEnabled: false, dbPath: ":memory:",
  bots: {
    codex: { token: undefined, command: "codex", modelPreference: ["cheap"] },
    claude: { token: undefined, command: "claude", modelPreference: [] },
    antigravity: { token: undefined, command: "agy", modelPreference: [] },
    kimchi: { token: undefined, command: "kimchi", modelPreference: [] },
  },
});

describe("BridgeEngine advisor command", () => {
  beforeEach(() => {
    process.env.BRIDGE_ADVISOR_ENABLED = "true";
    process.env.BRIDGE_ADVISOR_CHAIN = "claude:fable-5,codex:gpt-5.6-luna";
  });
  afterEach(() => {
    delete process.env.BRIDGE_ADVISOR_ENABLED;
    delete process.env.BRIDGE_ADVISOR_CHAIN;
  });

  it("runs the advisor chain and sends a labelled result without replacing the executor session", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    const db = openDb(":memory:");
    db.setSession("100", "codex", "executor-session");
    const messaging = client();
    const runCli = vi.fn().mockResolvedValue(JSON.stringify({
      advice_md: "Use the smaller design.", risks: ["Scope"], suggested_next_steps: ["Test it"], confidence: "high",
    }));
    const engine = new BridgeEngine({
      kind: "codex", botConfig: config().bots.codex, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000, fullConfig: config(),
    }, db, messaging, { runCli });

    await engine.handleMessages([message("/advisor ask Review the design")]);

    expect(runCli).toHaveBeenCalledOnce();
    expect(messaging.sendMessage.mock.calls.at(-1)?.[0].text).toContain("Advisor view");
    expect(db.getSession("100", "codex")).toBe("executor-session");
    db.close();
  });
});
