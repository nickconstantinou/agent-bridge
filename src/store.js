import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
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
  const ensureFile = async () => {
    await mkdir(dirname(filePath), { recursive: true });
    try {
      const content = await readFile(filePath, "utf8");
      JSON.parse(content);
    } catch {
      await writeFile(filePath, JSON.stringify(defaultValue, null, 2));
    }
  };

  return {
    async read() {
      await ensureFile();
      try {
        const content = await readFile(filePath, "utf8");
        return JSON.parse(content);
      } catch {
        await writeFile(filePath, JSON.stringify(defaultValue, null, 2));
        return structuredClone(defaultValue);
      }
    },
    async write(next) {
      await ensureFile();
      const current = await this.read();
      const updated = { ...current, ...next };
      const tempPath = `${filePath}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tempPath, JSON.stringify(updated, null, 2));
      await rename(tempPath, filePath);
    },
  };
}
