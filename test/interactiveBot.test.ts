/**
 * Tests for the interactive bot's CLI routing and /switch + /cli commands.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import type { BridgeDb } from "../src/db.js";
import type { TelegramUpdate } from "../src/types.js";
import { WorkerFallbackChain } from "../src/workerFallback.js";
import {
  getUserCliPreference,
  setUserCliPreference,
  buildCliStatusText,
  buildCliKeyboard,
  handleCliSwitchCallback,
  resolveUpdateChatKey,
  isAuthorizedInteractiveUpdate,
  buildInteractiveCommands,
  dispatchInteractiveWithFallback,
  type CliKind,
} from "../src/interactiveBot.js";

const VALID_CLI_KINDS: CliKind[] = ["codex", "claude", "antigravity"];

describe("getUserCliPreference", () => {
  let db: BridgeDb;
  beforeEach(() => { db = openDb(":memory:"); });

  it("returns codex as default when no preference is stored", () => {
    expect(getUserCliPreference(db, "chat:1")).toBe("codex");
  });

  it("returns the stored preference after setUserCliPreference", () => {
    setUserCliPreference(db, "chat:1", "claude");
    expect(getUserCliPreference(db, "chat:1")).toBe("claude");
  });

  it("preferences are per chat_id", () => {
    setUserCliPreference(db, "chat:1", "claude");
    setUserCliPreference(db, "chat:2", "antigravity");
    expect(getUserCliPreference(db, "chat:1")).toBe("claude");
    expect(getUserCliPreference(db, "chat:2")).toBe("antigravity");
  });

  it("updating preference overwrites the previous value", () => {
    setUserCliPreference(db, "chat:1", "claude");
    setUserCliPreference(db, "chat:1", "codex");
    expect(getUserCliPreference(db, "chat:1")).toBe("codex");
  });
});


describe("buildCliStatusText", () => {
  it("names the active CLI", () => {
    for (const cli of VALID_CLI_KINDS) {
      expect(buildCliStatusText(cli)).toContain(cli);
    }
  });

  it("lists available CLIs", () => {
    const text = buildCliStatusText("codex");
    for (const cli of VALID_CLI_KINDS) {
      expect(text).toContain(cli);
    }
  });
});

// ── resolveUpdateChatKey ──────────────────────────────────────────────────────

describe("resolveUpdateChatKey", () => {
  it("returns chat id from message", () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: { message_id: 10, chat: { id: 123, type: "private" }, from: { id: 99, first_name: "A" }, text: "hello" },
    };
    expect(resolveUpdateChatKey(update)).toBe("123");
  });

  it("returns chat id from callback_query message", () => {
    const update: TelegramUpdate = {
      update_id: 2,
      callback_query: {
        id: "cbq1",
        from: { id: 99, first_name: "A" },
        message: { message_id: 5, chat: { id: 456, type: "private" } },
        data: "model:codex:o4-mini",
      },
    };
    expect(resolveUpdateChatKey(update)).toBe("456");
  });

  it("returns null when neither message nor callback_query present", () => {
    const update: TelegramUpdate = { update_id: 3 };
    expect(resolveUpdateChatKey(update)).toBeNull();
  });

  it("prefers message chat id when both are somehow present", () => {
    const update: TelegramUpdate = {
      update_id: 4,
      message: { message_id: 1, chat: { id: 111, type: "private" }, from: { id: 99, first_name: "A" }, text: "hi" },
      callback_query: {
        id: "cbq2",
        from: { id: 99, first_name: "A" },
        message: { message_id: 2, chat: { id: 222, type: "private" } },
        data: "model:codex:o4-mini",
      },
    };
    expect(resolveUpdateChatKey(update)).toBe("111");
  });
});

// ── isAuthorizedInteractiveUpdate ─────────────────────────────────────────────

describe("isAuthorizedInteractiveUpdate", () => {
  const allowed = new Set(["99"]);

  it("allows message from an authorized user", () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: { message_id: 1, chat: { id: 1, type: "private" }, from: { id: 99, first_name: "A" }, text: "hi" },
    };
    expect(isAuthorizedInteractiveUpdate(update, allowed)).toBe(true);
  });

  it("rejects message from an unauthorized user", () => {
    const update: TelegramUpdate = {
      update_id: 2,
      message: { message_id: 2, chat: { id: 1, type: "private" }, from: { id: 77, first_name: "X" }, text: "hi" },
    };
    expect(isAuthorizedInteractiveUpdate(update, allowed)).toBe(false);
  });

  it("allows callback_query from an authorized user", () => {
    const update: TelegramUpdate = {
      update_id: 3,
      callback_query: {
        id: "cbq1",
        from: { id: 99, first_name: "A" },
        message: { message_id: 5, chat: { id: 1, type: "private" } },
        data: "model:codex:o4-mini",
      },
    };
    expect(isAuthorizedInteractiveUpdate(update, allowed)).toBe(true);
  });

  it("rejects callback_query from an unauthorized user", () => {
    const update: TelegramUpdate = {
      update_id: 4,
      callback_query: {
        id: "cbq2",
        from: { id: 77, first_name: "X" },
        message: { message_id: 6, chat: { id: 1, type: "private" } },
        data: "model:codex:o4-mini",
      },
    };
    expect(isAuthorizedInteractiveUpdate(update, allowed)).toBe(false);
  });

  it("rejects an update with no message and no callback_query", () => {
    const update: TelegramUpdate = { update_id: 5 };
    expect(isAuthorizedInteractiveUpdate(update, allowed)).toBe(false);
  });
});

// ── buildInteractiveCommands ──────────────────────────────────────────────────

describe("buildInteractiveCommands", () => {
  it("includes /cli command", () => {
    const cmds = buildInteractiveCommands("codex");
    expect(cmds.some(c => c.command === "cli")).toBe(true);
  });

  it("does not include /switch command — /cli handles switching via keyboard", () => {
    for (const pref of VALID_CLI_KINDS) {
      expect(buildInteractiveCommands(pref).some(c => c.command === "switch")).toBe(false);
    }
  });

  it("includes underlying CLI commands (/models, /reset) but not skills or memory", () => {
    const cmds = buildInteractiveCommands("claude");
    const names = cmds.map(c => c.command);
    expect(names).toContain("models");
    expect(names).toContain("reset");
    expect(names).not.toContain("skills");
    expect(names).not.toContain("memory");
  });

  it("includes /usage only when pref is codex", () => {
    const codexCmds = buildInteractiveCommands("codex").map(c => c.command);
    const claudeCmds = buildInteractiveCommands("claude").map(c => c.command);
    expect(codexCmds).toContain("usage");
    expect(claudeCmds).not.toContain("usage");
  });

  it("has no duplicate command names", () => {
    for (const pref of VALID_CLI_KINDS) {
      const names = buildInteractiveCommands(pref).map(c => c.command);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

// ── buildCliKeyboard ──────────────────────────────────────────────────────────

describe("buildCliKeyboard", () => {
  it("returns an inline_keyboard with one row per CLI kind", () => {
    const kb = buildCliKeyboard("codex");
    expect(kb.inline_keyboard).toHaveLength(3);
  });

  it("marks the active CLI with a checkmark", () => {
    const kb = buildCliKeyboard("claude");
    const allButtons = kb.inline_keyboard.flat();
    const active = allButtons.find((b) => b.text.includes("✓"));
    expect(active).toBeDefined();
    expect(active!.text).toContain("claude");
  });

  it("does not mark inactive CLIs with a checkmark", () => {
    const kb = buildCliKeyboard("codex");
    const allButtons = kb.inline_keyboard.flat();
    const checked = allButtons.filter((b) => b.text.includes("✓"));
    expect(checked).toHaveLength(1);
    expect(checked[0].text).toContain("codex");
  });

  it("callback_data encodes the CLI kind for each button", () => {
    const kb = buildCliKeyboard("codex");
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.every((b) => b.callback_data.startsWith("cli:"))).toBe(true);
    for (const cli of VALID_CLI_KINDS) {
      expect(allButtons.some((b) => b.callback_data === `cli:${cli}`)).toBe(true);
    }
  });

  it("all callback_data values are under 64 bytes", () => {
    for (const pref of VALID_CLI_KINDS) {
      const kb = buildCliKeyboard(pref);
      for (const row of kb.inline_keyboard) {
        for (const btn of row) {
          expect(Buffer.byteLength(btn.callback_data, "utf8")).toBeLessThan(64);
        }
      }
    }
  });
});

// ── handleCliSwitchCallback ───────────────────────────────────────────────────

describe("handleCliSwitchCallback", () => {
  it("parses cli:codex → codex", () => {
    expect(handleCliSwitchCallback("cli:codex")).toBe("codex");
  });

  it("parses cli:claude → claude", () => {
    expect(handleCliSwitchCallback("cli:claude")).toBe("claude");
  });

  it("parses cli:antigravity → antigravity", () => {
    expect(handleCliSwitchCallback("cli:antigravity")).toBe("antigravity");
  });

  it("returns null for unrecognized prefix", () => {
    expect(handleCliSwitchCallback("model:codex:gpt4")).toBeNull();
  });

  it("returns null for cli: with unknown kind", () => {
    expect(handleCliSwitchCallback("cli:gpt")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(handleCliSwitchCallback("")).toBeNull();
  });
});

// ── dispatchInteractiveWithFallback ───────────────────────────────────────────

describe("dispatchInteractiveWithFallback", () => {
  let db: BridgeDb;
  let codex: { handleUpdate: any; handleCount: number };
  let claude: { handleUpdate: any; handleCount: number };
  let antigravity: { handleUpdate: any; handleCount: number };
  let fallbackChain: WorkerFallbackChain;
  let exhaustedChats: Set<string>;
  let contextPreambles: Map<string, string>;
  let sentMessages: string[];
  let onCliSwitchedCalls: CliKind[];

  beforeEach(() => {
    db = openDb(":memory:");
    codex = { handleCount: 0, handleUpdate: async () => { codex.handleCount++; } };
    claude = { handleCount: 0, handleUpdate: async () => { claude.handleCount++; } };
    antigravity = { handleCount: 0, handleUpdate: async () => { antigravity.handleCount++; } };
    fallbackChain = new WorkerFallbackChain(["codex", "claude", "antigravity"]);
    exhaustedChats = new Set();
    contextPreambles = new Map();
    sentMessages = [];
    onCliSwitchedCalls = [];
  });

  const deps = () => ({
    engines: { codex, claude, antigravity },
    fallbackChain,
    exhaustedChats,
    contextPreambles,
    db,
    notify: (msg: string) => { sentMessages.push(msg); },
    onCliSwitched: async (newCli: CliKind) => { onCliSwitchedCalls.push(newCli); },
  });

  it("routes to the user's preferred CLI from DB", async () => {
    setUserCliPreference(db, "chat:1", "claude");
    await dispatchInteractiveWithFallback({ update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any, "chat:1", deps());
    expect(claude.handleCount).toBe(1);
    expect(codex.handleCount).toBe(0);
  });

  it("automatically falls back to the next CLI and updates DB when exhausted", async () => {
    setUserCliPreference(db, "chat:1", "codex");
    codex.handleUpdate = async () => {
      codex.handleCount++;
      exhaustedChats.add("chat:1");
    };

    await dispatchInteractiveWithFallback({ update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any, "chat:1", deps());

    expect(codex.handleCount).toBe(1);
    expect(claude.handleCount).toBe(1);
    expect(getUserCliPreference(db, "chat:1")).toBe("claude");
    expect(sentMessages).toContain("Switching to claude (codex at capacity)");
    expect(onCliSwitchedCalls).toContain("claude");
  });

  it("sets context preamble when falling back", async () => {
    setUserCliPreference(db, "chat:1", "codex");
    fallbackChain.addTurn("chat:1", "user", "previous question");
    codex.handleUpdate = async () => {
      codex.handleCount++;
      exhaustedChats.add("chat:1");
    };

    await dispatchInteractiveWithFallback({ update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any, "chat:1", deps());

    expect(contextPreambles.has("chat:1")).toBe(true);
    expect(contextPreambles.get("chat:1")).toContain("previous question");
  });
});

