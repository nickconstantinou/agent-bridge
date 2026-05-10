import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { TelegramClient } from "../src/telegram.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("Telegram Polling Lease", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-bridge-lock-test-"));
    lockPath = path.join(tempDir, "telegram.lock");
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("acquires a lock and prevents others from acquiring it", async () => {
    const client1 = new TelegramClient("token");
    const client2 = new TelegramClient("token");

    const acquire1 = await client1.acquireLease(lockPath);
    expect(acquire1).toBe(true);

    // Verify lock file exists
    const stats = await fs.stat(lockPath);
    expect(stats.isFile()).toBe(true);
    const pid = await fs.readFile(lockPath, "utf-8");
    expect(pid).toBe(String(process.pid));

    // Try to acquire again with client2
    await expect(client2.acquireLease(lockPath)).rejects.toThrow(/already locked/i);
  });

  it("releases the lock", async () => {
    const client = new TelegramClient("token");
    
    await client.acquireLease(lockPath);
    expect(await fs.stat(lockPath)).toBeDefined();
    
    await client.releaseLease();
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it("acquires a lock even when the parent directory does not exist yet", async () => {
    const client = new TelegramClient("token");
    const missingDir = path.join(tempDir, "sub", "dir");
    const missingLockPath = path.join(missingDir, "telegram.lock");

    const acquired = await client.acquireLease(missingLockPath);
    expect(acquired).toBe(true);

    await client.releaseLease();
  });

  it("handles concurrent stale-lock deletion gracefully (TOCTTOU)", async () => {
    const client = new TelegramClient("token");

    // Write a stale lock with a dead PID
    await fs.writeFile(lockPath, "999999");

    // Simulate the race: another process deletes the stale lock between our
    // readFile and unlink calls by monkey-patching fs.unlink.
    const origUnlink = fs.unlink.bind(fs);
    let unlinkCalled = false;
    (fs as any).unlink = async (p: string) => {
      if (!unlinkCalled && p === lockPath) {
        unlinkCalled = true;
        try { await origUnlink(p); } catch { /* already gone */ }
        const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        throw err;
      }
      return origUnlink(p);
    };

    try {
      const acquired = await client.acquireLease(lockPath);
      expect(acquired).toBe(true);
    } finally {
      (fs as any).unlink = origUnlink;
      await client.releaseLease();
    }
  });

  it("recovers from a stale lock if the process is no longer running", async () => {
    const client = new TelegramClient("token");
    
    // Create a stale lock with a PID that is unlikely to be running
    const stalePid = "999999";
    await fs.writeFile(lockPath, stalePid);

    // Should succeed because PID 999999 is (likely) not running
    const acquired = await client.acquireLease(lockPath);
    expect(acquired).toBe(true);

    const newPid = await fs.readFile(lockPath, "utf-8");
    expect(newPid).toBe(String(process.pid));
  });
});
