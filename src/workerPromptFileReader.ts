/**
 * PURPOSE: Filesystem-backed reader for version-controlled worker prompt files.
 * NEIGHBORS: src/workerPrompts.ts, src/handlers/implementationPlan.ts
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkerPromptReader } from "./workerPrompts.js";

export interface WorkerPromptFileReaderOptions {
  rootDir?: string;
}

export class WorkerPromptFileReader implements WorkerPromptReader {
  private readonly rootDir: string;

  constructor(options: WorkerPromptFileReaderOptions = {}) {
    this.rootDir = options.rootDir ?? process.cwd();
  }

  async readText(path: string): Promise<string> {
    const absolutePath = resolve(this.rootDir, path);
    return readFile(absolutePath, "utf8");
  }
}

export function createWorkerPromptFileReader(options: WorkerPromptFileReaderOptions = {}): WorkerPromptFileReader {
  return new WorkerPromptFileReader(options);
}
