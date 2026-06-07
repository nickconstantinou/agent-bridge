/**
 * Tests for the interactive bot's CLI routing and /switch + /cli commands.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import type { BridgeDb } from "../src/db.js";
import type { TelegramUpdate } from "../src/types.js";
import {
  getUserCliPreference,
  setUserCliPreference,
  parseCliSwitchCommand,
  buildCliStatusText,
  resolveUpdateChatKey,
  isAuthorizedInteractiveUpdate,
  buildInteractiveCommands,
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

describe("parseCliSwitchCommand", () => {
  it("parses /switch codex", () => {
    expect(parseCliSwitchCommand("/switch codex")).toEqual({ ok: true, cli: "codex" });
  });

  it("parses /switch claude", () => {
    expect(parseCliSwitchCommand("/switch claude")).toEqual({ ok: true, cli: "claude" });
  });

  it("parses /switch antigravity", () => {
    expect(parseCliSwitchCommand("/switch antigravity")).toEqual({ ok: true, cli: "antigravity" });
  });

  it("is case-insensitive", () => {
    expect(parseCliSwitchCommand("/switch Claude")).toEqual({ ok: true, cli: "claude" });
  });

  it("returns error for unknown CLI", () => {
    const result = parseCliSwitchCommand("/switch gpt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("codex");
  });

  it("returns error when no CLI specified", () => {
    const result = parseCliSwitchCommand("/switch");
    expect(result.ok).toBe(false);
  });

  it("returns null for non-switch commands", () => {
    expect(parseCliSwitchCommand("/cli")).toBeNull();
    expect(parseCliSwitchCommand("/reset")).toBeNull();
    expect(parseCliSwitchCommand("hello")).toBeNull();
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

  it("includes /switch command", () => {
    const cmds = buildInteractiveCommands("codex");
    expect(cmds.some(c => c.command === "switch")).toBe(true);
  });

  it("includes underlying CLI commands (/models, /reset, /skills)", () => {
    const cmds = buildInteractiveCommands("claude");
    const names = cmds.map(c => c.command);
    expect(names).toContain("models");
    expect(names).toContain("reset");
    expect(names).toContain("skills");
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
