import { mkdir, readdir, unlink, rm } from "node:fs/promises";
import { join, extname } from "node:path";
import type { TelegramClient } from "./telegram.js";

const BRIDGE_OUT_BASE = "/tmp/bridge-out";

export async function prepareOutputDir(chatId: number | string, kind: string): Promise<string> {
  const dir = join(BRIDGE_OUT_BASE, `${kind}-${String(chatId)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function collectOutputFiles(outDir: string): Promise<string[]> {
  try {
    const entries = await readdir(outDir);
    return entries.map((name) => join(outDir, name));
  } catch {
    return [];
  }
}

export async function cleanOutputDir(outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export async function uploadOutputFiles(
  outDir: string,
  chatId: number,
  client: Pick<TelegramClient, "sendPhoto" | "sendDocument">,
): Promise<void> {
  const files = await collectOutputFiles(outDir);
  for (const filePath of files) {
    const ext = extname(filePath).toLowerCase();
    try {
      if (IMAGE_EXTENSIONS.has(ext)) {
        await client.sendPhoto(chatId, filePath);
      } else {
        await client.sendDocument(chatId, filePath);
      }
      await unlink(filePath).catch(() => {/* ignore if already gone */});
    } catch (err) {
      console.error(`[fileOutput] upload failed for ${filePath}:`, err);
    }
  }
  await cleanOutputDir(outDir);
}
