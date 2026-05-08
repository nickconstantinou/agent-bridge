import { mkdir, readFile, writeFile, rename, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  return {
    async read() {
      return structuredClone(data);
    },
    async write(next) {
      data = { ...data, ...next };
    },
  };
}

export function createFileStore(filePath, defaultValue = {}) {
  const lockPath = `${filePath}.lock`;

  async function withLock(fn) {
    await mkdir(dirname(filePath), { recursive: true });
    let handle;
    for (;;) {
      try {
        handle = await open(lockPath, "wx");
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    try {
      return await fn();
    } finally {
      try {
        await handle?.close();
      } finally {
        await unlink(lockPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
    }
  }

  const ensureFile = async () => {
    await mkdir(dirname(filePath), { recursive: true });
    try {
      await readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await writeFile(filePath, JSON.stringify(defaultValue, null, 2));
    }
  };

  return {
    async read() {
      try {
        await ensureFile();
        const content = await readFile(filePath, "utf8");
        return JSON.parse(content);
      } catch (error) {
        if (error?.name === "SyntaxError") {
          await writeFile(filePath, JSON.stringify(defaultValue, null, 2));
          return structuredClone(defaultValue);
        }
        throw error;
      }
    },
    async write(next) {
      return withLock(async () => {
        await ensureFile();
        const content = await readFile(filePath, "utf8");
        const current = JSON.parse(content);
        const updated = { ...current, ...next };
        const tempPath = `${filePath}.${Math.random().toString(36).slice(2)}.tmp`;
        await writeFile(tempPath, JSON.stringify(updated, null, 2));
        await rename(tempPath, filePath);
      });
    },
  };
}
