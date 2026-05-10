import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "./types.js";

/**
 * Creates a file-based store.
 */
export function createFileStore<T extends object>(filePath: string, defaultValue: T): Store<T> {
  const ensureDir = () => {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  };

  async function withLock<R>(fn: () => Promise<R>): Promise<R> {
    const lockPath = `${filePath}.lock`;
    const unlinkSync = (path: string) => {
        try {
            const fs = readFileSync; // not ideal but we need access to fs
            // Wait, I can just import it.
        } catch {}
    };

    // Re-importing fs in a better way
    const fs = await import("node:fs");

    let attempts = 0;
    while (attempts < 100) {
      try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
        try {
          return await fn();
        } finally {
          try {
            fs.unlinkSync(lockPath);
          } catch { /* ignore */ }
        }
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
        attempts += 1;
      }
    }
    throw new Error(`Could not acquire lock for ${filePath} after ${attempts} attempts`);
  }

  return {
    async read(): Promise<T> {
      try {
        if (!existsSync(filePath)) return defaultValue;
        const content = readFileSync(filePath, "utf-8");
        return JSON.parse(content);
      } catch (error: any) {
        return defaultValue;
      }
    },
    async write(next: Partial<T>): Promise<void> {
      await withLock(async () => {
        ensureDir();
        const current = await this.read();
        const updated = { ...current, ...next };
        writeFileSync(filePath, JSON.stringify(updated, null, 2));
      });
    },
  };
}

export function createMemoryStore<T extends object>(initialValue: T): Store<T> {
  let data = { ...initialValue };
  return {
    async read(): Promise<T> {
      return data;
    },
    async write(next: Partial<T>): Promise<void> {
      data = { ...data, ...next };
    },
  };
}
