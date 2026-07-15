import { mkdir, readdir, unlink, rm } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import type { FileSendOptions, MessagingPlatform } from "./platform.js";

const BRIDGE_OUT_BASE = "/tmp/bridge-out";

export async function prepareOutputDir(chatId: number | string, kind: string, runId?: string): Promise<string> {
  const dir = join(BRIDGE_OUT_BASE, `${kind}-${String(chatId)}${runId ? `-${runId}` : ""}`);
  // Wipe any files left by a previous partial run before handing the dir to the CLI.
  await rm(dir, { recursive: true, force: true });
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
  client: Pick<MessagingPlatform, "sendPhoto" | "sendDocument">,
  options?: FileSendOptions,
): Promise<void> {
  const files = await collectOutputFiles(outDir);
  if (files.length > 0) {
    console.log(`[fileOutput] uploading ${files.length} file(s) for chatId=${chatId}: ${files.map((f) => basename(f)).join(", ")}`);
  }
  for (const filePath of files) {
    const ext = extname(filePath).toLowerCase();
    try {
      if (IMAGE_EXTENSIONS.has(ext)) {
        await client.sendPhoto(chatId, filePath, undefined, options);
      } else {
        await client.sendDocument(chatId, filePath, undefined, options);
      }
      console.log(`[fileOutput] uploaded ${basename(filePath)}`);
      await unlink(filePath).catch(() => {/* ignore if already gone */});
    } catch (err) {
      console.error(`[fileOutput] upload failed for ${basename(filePath)}:`, err);
    }
  }
  await cleanOutputDir(outDir);
}
