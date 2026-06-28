/**
 * Tests for the pending-feature-brief capture flow.
 * After a bare /feature command, the next plain message from the same chat
 * should be treated as the feature brief rather than forwarded to the CLI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { handleWorkerCommand } from "../src/workerBot.js";
import {
  captureFeatureBrief,
  hasPendingFeatureBrief,
  clearPendingFeatureBrief,
  setPendingFeatureBrief,
  setPendingRepoBrief,
  consumePendingRepoBrief,
} from "../src/featureBriefCapture.js";

function makeDb() {
  const dbPath = join(tmpdir(), `feature-brief-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
  return { db, dbPath };
}

describe("captureFeatureBrief module", () => {
  afterEach(() => {
    // Clean up any state left by tests
    clearPendingFeatureBrief("chat:1");
    clearPendingFeatureBrief("chat:2");
    clearPendingFeatureBrief("chat:3");
    clearPendingFeatureBrief("chat:4");
    clearPendingFeatureBrief("chat:6");
  });

  it("returns false when no pending brief for chat", () => {
    expect(hasPendingFeatureBrief("chat:1")).toBe(false);
  });

  it("sets pending after setPendingFeatureBrief", () => {
    setPendingFeatureBrief("chat:2");
    expect(hasPendingFeatureBrief("chat:2")).toBe(true);
  });

  it("clears pending after capture", () => {
    setPendingFeatureBrief("chat:3");
    captureFeatureBrief("chat:3", "my brief");
    expect(hasPendingFeatureBrief("chat:3")).toBe(false);
  });

  it("returns the captured brief text", () => {
    setPendingFeatureBrief("chat:4");
    const result = captureFeatureBrief("chat:4", "add dark mode");
    expect(result).toBe("add dark mode");
  });

  it("returns null when no pending brief", () => {
    const result = captureFeatureBrief("chat:5", "some message");
    expect(result).toBeNull();
  });

  it("is independent per chat key", () => {
    setPendingFeatureBrief("chat:6");
    expect(hasPendingFeatureBrief("chat:6")).toBe(true);
    expect(hasPendingFeatureBrief("chat:99")).toBe(false);
  });
});

describe("handleWorkerCommand — bare /feature sets pending brief", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb());
  });
  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
    clearPendingFeatureBrief("200");
    clearPendingFeatureBrief("300");
  });

  it("returns the 'describe the feature' prompt when brief is missing", async () => {
    const result = await handleWorkerCommand("/feature", {
      workerEnabled: true, db, chatId: 200, userId: "u1",
    });
    expect(result?.kind).toBe("message");
    expect(result?.text).toMatch(/describe|feature/i);
  });

  it("sets a pending brief capture for the chat after bare /feature", async () => {
    await handleWorkerCommand("/feature", {
      workerEnabled: true, db, chatId: 200, userId: "u1",
    });
    expect(hasPendingFeatureBrief("200")).toBe(true);
  });

  it("does NOT set pending brief when a brief is already provided", async () => {
    await handleWorkerCommand("/feature build a thing", {
      workerEnabled: true, db, chatId: 300, userId: "u1",
    });
    expect(hasPendingFeatureBrief("300")).toBe(false);
  });
});

describe("pendingRepoBrief", () => {
  afterEach(() => {
    // Clean up any pending repo briefs
    consumePendingRepoBrief("123");
    consumePendingRepoBrief("456");
    consumePendingRepoBrief("789");
    consumePendingRepoBrief("999");
  });

  it("stores and consumes a brief", () => {
    setPendingRepoBrief("123", "add dark mode");
    expect(consumePendingRepoBrief("123")).toBe("add dark mode");
  });

  it("consume returns null when nothing pending", () => {
    expect(consumePendingRepoBrief("999")).toBeNull();
  });

  it("consume clears the brief", () => {
    setPendingRepoBrief("456", "brief text");
    consumePendingRepoBrief("456");
    expect(consumePendingRepoBrief("456")).toBeNull();
  });

  it("overwrite replaces existing brief", () => {
    setPendingRepoBrief("789", "first");
    setPendingRepoBrief("789", "second");
    expect(consumePendingRepoBrief("789")).toBe("second");
  });
});
