/**
 * PURPOSE: Async child-process runner for job handler wiring (git, gh, npm).
 * Replaces execFileSync usage that blocked the Telegram polling loop for the
 * full duration of child commands. Optionally loads GH_TOKEN from the secrets
 * file so gh API calls work consistently across all handlers.
 * NEIGHBORS: src/index-worker.ts, src/workCallbacks.ts
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

export interface RunCommandOptions {
  /** Load GH_TOKEN from $GITHUB_TOKEN_FILE (default ~/.secrets/GITHUB_TOKEN.TXT) into the child env. */
  loadGhToken?: boolean;
  /** Max stdout/stderr buffer; defaults to 10 MB. */
  maxBuffer?: number;
}

export type RunCommand = (
  binary: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<string>;

export function createRunCommand(options: RunCommandOptions = {}): RunCommand {
  const { loadGhToken = false, maxBuffer = 10 * 1024 * 1024 } = options;

  return (binary, args, opts = {}) =>
    new Promise<string>((resolve, reject) => {
      const env = opts.env ? { ...opts.env } : { ...process.env };
      if (loadGhToken) {
        const tokenPath = process.env.GITHUB_TOKEN_FILE || `${process.env.HOME}/.secrets/GITHUB_TOKEN.TXT`;
        try { env.GH_TOKEN = readFileSync(tokenPath, "utf8").trim(); } catch { /* git ops still work without it */ }
      }

      execFile(binary, args, { encoding: "utf8", env, maxBuffer, cwd: opts.cwd }, (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || "").trim() || err.message;
          reject(new Error(detail));
          return;
        }
        resolve(stdout.trim());
      });
    });
}
