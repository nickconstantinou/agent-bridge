/**
 * PURPOSE: GitHub repo discovery, keyboard builder, and callback parser for the repo picker.
 * NEIGHBORS: src/workerBot.ts, src/workCallbacks.ts
 */

import { execFile } from "node:child_process";

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { repos: Array<{ name: string; full_name: string }>; at: number } | null = null;

export function resolveGithubOwner(): string {
  const u = process.env.GITHUB_USERNAME;
  if (!u) throw new Error("GITHUB_USERNAME env var is not set");
  return u;
}

function ghAsync(args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile("gh", args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) rej(new Error((stderr || "").trim() || err.message));
      else res(stdout.trim());
    });
  });
}

export async function fetchUserRepos(): Promise<Array<{ name: string; full_name: string }>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.repos;
  // gh --paginate with --jq outputs one JSON object per line (NDJSON)
  const raw = await ghAsync(["api", "/user/repos", "--paginate", "--jq", ".[] | {name, full_name}"]);
  const repos = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { name: string; full_name: string };
      } catch {
        return null;
      }
    })
    .filter((r): r is { name: string; full_name: string } => r !== null && typeof r.name === "string");
  cache = { repos, at: Date.now() };
  return repos;
}

export async function buildRepoKeyboard(
  ctx: string,
): Promise<{ inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | null> {
  let repos: Array<{ name: string; full_name: string }>;
  try {
    repos = await fetchUserRepos();
  } catch (err) {
    console.warn("[repoRegistry] fetchUserRepos failed:", err);
    return null;
  }
  if (repos.length === 0) return null;

  const buttons = repos
    .filter((r) => {
      const payload = `rs:${r.name}:${ctx}`;
      return payload.length <= 64;
    })
    .map((r) => ({ text: r.name, callback_data: `rs:${r.name}:${ctx}` }));

  if (buttons.length === 0) return null;

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return { inline_keyboard: rows };
}

export async function buildRepoSetKeyboard(): Promise<{ inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }> {
  let repos: Array<{ name: string; full_name: string }> = [];
  try {
    repos = await fetchUserRepos();
  } catch (err) {
    console.warn("[repoRegistry] fetchUserRepos failed:", err);
  }

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  const repoButtons = repos
    .filter((r) => `rd:${r.name}`.length <= 64)
    .map((r) => ({ text: r.name, callback_data: `rd:${r.name}` }));

  for (let i = 0; i < repoButtons.length; i += 2) {
    rows.push(repoButtons.slice(i, i + 2));
  }
  rows.push([{ text: "📝 Custom repo…", callback_data: "rd:__custom__" }]);
  return { inline_keyboard: rows };
}

export function parseRepoSelectCallback(data: string): { repo: string; ctx: string } | null {
  if (data.length > 64) return null;
  if (!data.startsWith("rs:")) return null;
  const rest = data.slice(3);
  const colon = rest.indexOf(":");
  if (colon < 1) return null;
  const repo = rest.slice(0, colon);
  const ctx = rest.slice(colon + 1);
  if (!repo || !ctx) return null;
  return { repo, ctx };
}
