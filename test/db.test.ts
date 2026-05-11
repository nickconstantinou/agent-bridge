import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { openDb, BridgeDb } from "../src/db.js";

let db: BridgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("BridgeDb sessions", () => {
  it("returns null for an unknown chat", () => {
    expect(db.getSession("chat1", "codex")).toBeNull();
    expect(db.getSession("chat1", "gemini")).toBeNull();
  });

  it("persists and retrieves a session per bot", () => {
    db.setSession("chat1", "codex", "codex-session-abc");
    db.setSession("chat1", "gemini", "gemini-session-xyz");
    expect(db.getSession("chat1", "codex")).toBe("codex-session-abc");
    expect(db.getSession("chat1", "gemini")).toBe("gemini-session-xyz");
  });

  it("updates an existing session without touching the other bot", () => {
    db.setSession("chat1", "codex", "v1");
    db.setSession("chat1", "gemini", "g1");
    db.setSession("chat1", "codex", "v2");
    expect(db.getSession("chat1", "codex")).toBe("v2");
    expect(db.getSession("chat1", "gemini")).toBe("g1");
  });

  it("clears a session when set to null", () => {
    db.setSession("chat1", "gemini", "s1");
    db.setSession("chat1", "gemini", null);
    expect(db.getSession("chat1", "gemini")).toBeNull();
  });

  it("keeps sessions isolated per chat", () => {
    db.setSession("chat1", "codex", "s-chat1");
    db.setSession("chat2", "codex", "s-chat2");
    expect(db.getSession("chat1", "codex")).toBe("s-chat1");
    expect(db.getSession("chat2", "codex")).toBe("s-chat2");
  });
});

describe("BridgeDb execution lock", () => {
  it("acquires lock when chat is free", () => {
    expect(db.tryLock("chat1")).toBe(true);
  });

  it("rejects lock when chat is already locked", () => {
    db.tryLock("chat1");
    expect(db.tryLock("chat1")).toBe(false);
  });

  it("lock is released by unlock", () => {
    db.tryLock("chat1");
    db.unlock("chat1");
    expect(db.tryLock("chat1")).toBe(true);
  });

  it("lock is per chat — other chats are unaffected", () => {
    db.tryLock("chat1");
    expect(db.tryLock("chat2")).toBe(true);
  });
});

describe("BridgeDb polling offset", () => {
  it("returns 0 for an unknown bot", () => {
    expect(db.getLastUpdateId("codex")).toBe(0);
    expect(db.getLastUpdateId("gemini")).toBe(0);
  });

  it("stores and retrieves the offset per bot", () => {
    db.setLastUpdateId("codex", 1000);
    db.setLastUpdateId("gemini", 2000);
    expect(db.getLastUpdateId("codex")).toBe(1000);
    expect(db.getLastUpdateId("gemini")).toBe(2000);
  });

  it("never decrements the offset (MAX semantics)", () => {
    db.setLastUpdateId("codex", 500);
    db.setLastUpdateId("codex", 100);
    expect(db.getLastUpdateId("codex")).toBe(500);
  });
});

describe("BridgeDb settings", () => {
  it("returns null for an unknown key", () => {
    expect(db.getSetting("codex")).toBeNull();
  });

  it("stores and retrieves a setting", () => {
    db.setSetting("gemini", "gemini-2.5-flash-lite");
    expect(db.getSetting("gemini")).toBe("gemini-2.5-flash-lite");
  });

  it("overwrites an existing setting", () => {
    db.setSetting("codex", "gpt-4o");
    db.setSetting("codex", "gpt-4o-mini");
    expect(db.getSetting("codex")).toBe("gpt-4o-mini");
  });

  it("clears a setting when set to null", () => {
    db.setSetting("codex", "gpt-4o");
    db.setSetting("codex", null);
    expect(db.getSetting("codex")).toBeNull();
  });
});
