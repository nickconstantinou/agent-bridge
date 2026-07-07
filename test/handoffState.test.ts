import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";
import {
  markHandoffRequired,
  isHandoffRequired,
  clearHandoffRequired,
  consumeHandoffRequired,
} from "../src/handoffState.js";

let db: BridgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("handoff state", () => {
  it("is not required by default", () => {
    expect(isHandoffRequired(db, "chat:1", "claude")).toBe(false);
  });

  it("becomes required after marking", () => {
    markHandoffRequired(db, "chat:1", "claude", "fallback");
    expect(isHandoffRequired(db, "chat:1", "claude")).toBe(true);
  });

  it("is isolated per chat key", () => {
    markHandoffRequired(db, "chat:1", "claude", "fallback");
    expect(isHandoffRequired(db, "chat:2", "claude")).toBe(false);
  });

  it("is isolated per CLI kind within the same chat", () => {
    markHandoffRequired(db, "chat:1", "claude", "fallback");
    expect(isHandoffRequired(db, "chat:1", "codex")).toBe(false);
  });

  it("clears on demand", () => {
    markHandoffRequired(db, "chat:1", "claude", "fallback");
    clearHandoffRequired(db, "chat:1", "claude");
    expect(isHandoffRequired(db, "chat:1", "claude")).toBe(false);
  });

  it("clearing an already-clear flag is a no-op, not an error", () => {
    expect(() => clearHandoffRequired(db, "chat:1", "claude")).not.toThrow();
    expect(isHandoffRequired(db, "chat:1", "claude")).toBe(false);
  });

  describe("consumeHandoffRequired", () => {
    it("returns false and does nothing when handoff was not required", () => {
      expect(consumeHandoffRequired(db, "chat:1", "claude")).toBe(false);
    });

    it("returns true exactly once, then clears the flag (one-time injection)", () => {
      markHandoffRequired(db, "chat:1", "claude", "manual switch");
      expect(consumeHandoffRequired(db, "chat:1", "claude")).toBe(true);
      expect(consumeHandoffRequired(db, "chat:1", "claude")).toBe(false);
      expect(isHandoffRequired(db, "chat:1", "claude")).toBe(false);
    });

    it("does not consume a different chat/CLI's handoff flag", () => {
      markHandoffRequired(db, "chat:1", "claude", "manual switch");
      expect(consumeHandoffRequired(db, "chat:2", "claude")).toBe(false);
      expect(consumeHandoffRequired(db, "chat:1", "codex")).toBe(false);
      // Original flag is untouched by the non-matching consume attempts.
      expect(isHandoffRequired(db, "chat:1", "claude")).toBe(true);
    });
  });
});
