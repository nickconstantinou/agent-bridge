/**
 * Tests for the interactive bot's CLI routing and /switch + /cli commands.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import type { BridgeDb } from "../src/db.js";
import {
  getUserCliPreference,
  setUserCliPreference,
  parseCliSwitchCommand,
  buildCliStatusText,
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
