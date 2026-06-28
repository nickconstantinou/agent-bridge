# GitHub Repo Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dynamic GitHub repo picker keyboard that appears whenever a worker command needs a repo but none is configured, replace hardcoded GitHub usernames with a `GITHUB_USERNAME` env var, add `/refactor` command, and silence transient worker failures.

**Architecture:** A new `repoRegistry.ts` module fetches repos via `gh api` and builds inline keyboards. `workerBot.ts` becomes async and calls the registry when no repo is resolved. `workCallbacks.ts` routes `rs:` prefix callbacks to the appropriate job creation or pending-brief consumption. Transient job failures are silenced in `jobExecutor.ts`; only permanent failures notify the user.

**Tech Stack:** TypeScript, Node.js, Telegram Bot API inline keyboards, `gh` CLI, better-sqlite3

## Global Constraints

- Callback data must be ≤64 bytes.
- Repo names in callbacks are short names only (no `owner/` prefix).
- `GITHUB_USERNAME` must be set in `.env.worker`; missing value throws at call site.
- All tests run with: `npm test` from `~/agent-bridge`.
- Type-check: `npm run typecheck`.
- All new task types must be registered in `src/index-worker.ts`.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `src/repoRegistry.ts` | Create | Repo fetch, keyboard build, callback parse, owner resolve |
| `src/featureBriefCapture.ts` | Modify | Add pending-repo-brief store (brief awaiting repo selection) |
| `src/workerBot.ts` | Modify | Make async, `/review` no-repo → keyboard, `/feature` no-repo → keyboard, `/refactor` new command |
| `src/workCallbacks.ts` | Modify | Handle `rs:` callbacks; route to defect_scan / refactor_scan / feature_plan |
| `src/handlers/refactorScan.ts` | Create | Job handler for `refactor_scan` task type |
| `src/jobExecutor.ts` | Modify | Silence transient failures; notify only on permanent failure |
| `src/index-worker.ts` | Modify | Await async `handleWorkerCommand`; register `refactor_scan` handler |
| `scripts/install.sh` | Modify | Add worker section: prompts for GITHUB_USERNAME, WORKER_DEFAULT_REPO, WORKER_ENABLED, TELEGRAM_BOT_TOKEN_WORKER |
| `.env.worker.example` | Modify | Add `GITHUB_USERNAME=` |

---

### Task 1: `src/repoRegistry.ts` — repo fetch, keyboard builder, callback parser

**Files:**
- Create: `src/repoRegistry.ts`
- Test: `tests/repoRegistry.test.ts`

**Interfaces:**
- Produces:
  - `resolveGithubOwner(): string` — returns `process.env.GITHUB_USERNAME` or throws `"GITHUB_USERNAME env var is not set"`
  - `fetchUserRepos(): Promise<Array<{name: string; full_name: string}>>` — cached 5 min in-process
  - `buildRepoKeyboard(ctx: string): Promise<{inline_keyboard: Array<Array<{text: string; callback_data: string}>>} | null>` — null on fetch failure
  - `parseRepoSelectCallback(data: string): {repo: string; ctx: string} | null`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/repoRegistry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveGithubOwner, parseRepoSelectCallback } from "../src/repoRegistry.js";

describe("resolveGithubOwner", () => {
  const original = process.env.GITHUB_USERNAME;
  afterEach(() => { process.env.GITHUB_USERNAME = original; });

  it("returns GITHUB_USERNAME when set", () => {
    process.env.GITHUB_USERNAME = "testuser";
    expect(resolveGithubOwner()).toBe("testuser");
  });

  it("throws when GITHUB_USERNAME is unset", () => {
    delete process.env.GITHUB_USERNAME;
    expect(() => resolveGithubOwner()).toThrow("GITHUB_USERNAME env var is not set");
  });
});

describe("parseRepoSelectCallback", () => {
  it("parses rs:<name>:<ctx>", () => {
    expect(parseRepoSelectCallback("rs:agent-bridge:r")).toEqual({ repo: "agent-bridge", ctx: "r" });
  });

  it("parses rs:<name>:f", () => {
    expect(parseRepoSelectCallback("rs:content-crawler:f")).toEqual({ repo: "content-crawler", ctx: "f" });
  });

  it("parses rs:<name>:rf", () => {
    expect(parseRepoSelectCallback("rs:dashboard:rf")).toEqual({ repo: "dashboard", ctx: "rf" });
  });

  it("returns null for non-rs prefix", () => {
    expect(parseRepoSelectCallback("wi:1:view")).toBeNull();
  });

  it("returns null when name is empty", () => {
    expect(parseRepoSelectCallback("rs::r")).toBeNull();
  });

  it("returns null when ctx is empty", () => {
    expect(parseRepoSelectCallback("rs:agent-bridge:")).toBeNull();
  });

  it("returns null for data > 64 bytes", () => {
    const long = "rs:" + "a".repeat(62) + ":r";
    expect(parseRepoSelectCallback(long)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/agent-bridge && npm test -- --reporter=verbose tests/repoRegistry.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/repoRegistry.ts`**

```typescript
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
    const ghToken = process.env.GH_TOKEN;
    const env = ghToken ? { ...process.env, GH_TOKEN: ghToken } : process.env;
    execFile("gh", args, { encoding: "utf8", env: env as NodeJS.ProcessEnv }, (err, stdout, stderr) => {
      if (err) rej(new Error((stderr || "").trim() || err.message));
      else res(stdout.trim());
    });
  });
}

export async function fetchUserRepos(): Promise<Array<{ name: string; full_name: string }>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.repos;
  const raw = await ghAsync(["api", "/user/repos", "--paginate", "-q", ".[] | {name, full_name}", "--jq", ".[] | {name, full_name}"]);
  // gh --paginate with --jq outputs one JSON object per line
  const repos = raw
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line) as { name: string; full_name: string }; }
      catch { return null; }
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
    .filter(r => {
      const payload = `rs:${r.name}:${ctx}`;
      return payload.length <= 64;
    })
    .map(r => ({ text: r.name, callback_data: `rs:${r.name}:${ctx}` }));

  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/agent-bridge && npm test -- tests/repoRegistry.test.ts
```
Expected: all `resolveGithubOwner` and `parseRepoSelectCallback` tests PASS.

- [ ] **Step 5: Typecheck**

```bash
cd ~/agent-bridge && npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/agent-bridge && git add src/repoRegistry.ts tests/repoRegistry.test.ts
git commit -m "feat(repo-registry): add repo fetch, keyboard builder, and callback parser"
```

---

### Task 2: `src/featureBriefCapture.ts` — pending repo-brief store

**Files:**
- Modify: `src/featureBriefCapture.ts`
- Test: `tests/featureBriefCapture.test.ts` (add new tests to existing file)

**Interfaces:**
- Produces:
  - `setPendingRepoBrief(chatKey: string, brief: string): void`
  - `consumePendingRepoBrief(chatKey: string): string | null`

- [ ] **Step 1: Write the failing tests**

Find the existing test file:
```bash
find ~/agent-bridge/tests -name "*featureBrief*" -o -name "*feature_brief*" 2>/dev/null
```

Add these tests to the existing test file (or create `tests/featureBriefCapture.test.ts`):

```typescript
import { setPendingRepoBrief, consumePendingRepoBrief } from "../src/featureBriefCapture.js";

describe("pendingRepoBrief", () => {
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
```

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/agent-bridge && npm test -- tests/featureBriefCapture.test.ts
```
Expected: FAIL — `setPendingRepoBrief` not exported.

- [ ] **Step 3: Add to `src/featureBriefCapture.ts`**

Append after the existing `captureFeatureBrief` export:

```typescript
const pendingRepoBriefs = new Map<string, string>();

export function setPendingRepoBrief(chatKey: string, brief: string): void {
  pendingRepoBriefs.set(chatKey, brief);
}

export function consumePendingRepoBrief(chatKey: string): string | null {
  const brief = pendingRepoBriefs.get(chatKey) ?? null;
  if (brief !== null) pendingRepoBriefs.delete(chatKey);
  return brief;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd ~/agent-bridge && npm test -- tests/featureBriefCapture.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/agent-bridge && git add src/featureBriefCapture.ts tests/featureBriefCapture.test.ts
git commit -m "feat(feature-brief): add pending repo-brief store for deferred repo selection"
```

---

### Task 3: `src/handlers/refactorScan.ts` — new job handler

**Files:**
- Create: `src/handlers/refactorScan.ts`
- Test: `tests/handlers/refactorScan.test.ts`

**Interfaces:**
- Consumes: same `RunCli`, `JobHandler`, `JobHandlerInput`, `JobHandlerContext`, `JobHandlerResult` types as `defectScan.ts`
- Produces:
  - `createRefactorScanHandler(deps: RefactorScanDeps): JobHandler` — registered as `refactor_scan` in `index-worker.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/handlers/refactorScan.test.ts
import { describe, it, expect, vi } from "vitest";
import { createRefactorScanHandler } from "../../src/handlers/refactorScan.js";

describe("createRefactorScanHandler", () => {
  it("returns a function (handler)", () => {
    const handler = createRefactorScanHandler({ runCli: vi.fn() });
    expect(typeof handler).toBe("function");
  });

  it("throws when input.repository is missing", async () => {
    const handler = createRefactorScanHandler({ runCli: vi.fn() });
    await expect(handler({} as any, {} as any)).rejects.toThrow("input.repository is required");
  });

  it("calls runCli with repository name in prompt", async () => {
    const runCli = vi.fn().mockResolvedValue(`[]`);
    const mockDb = {
      createWorkItem: vi.fn().mockReturnValue({ id: 1 }),
      raw: { prepare: vi.fn().mockReturnValue({ run: vi.fn() }) },
    };
    const handler = createRefactorScanHandler({ runCli });
    await handler({ repository: "test-repo" }, { db: mockDb } as any);
    expect(runCli).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([expect.stringContaining("test-repo")]),
      expect.any(String),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/agent-bridge && npm test -- tests/handlers/refactorScan.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/handlers/refactorScan.ts`**

```typescript
/**
 * PURPOSE: Job handler for refactor_scan task type.
 * Runs a refactoring analysis of a repository via CLI and creates proposed work_items.
 * NEIGHBORS: src/jobExecutor.ts, src/index-worker.ts
 */

import type { JobHandler, JobHandlerInput, JobHandlerContext } from "../jobExecutor.js";
import { resolveLocalRepoPath } from "../workspace.js";

type RunCli = (command: string, args: string[], cwd?: string) => Promise<string>;

interface RefactorScanDeps {
  runCli: RunCli;
  command?: string;
  resolveRepoPath?: (repository: string) => string | null;
}

function buildPrompt(repository: string): string {
  return `You are performing a read-only refactoring analysis of the repository: ${repository}.

Your task:
1. Examine the repository structure, key source files, and TypeScript/JS patterns.
2. Identify up to 5 concrete refactoring opportunities: dead code, duplicated logic, oversized files, unclear boundaries, or naming that harms readability.
3. For each finding output a JSON object on its own line: {"title": "...", "rationale": "...", "files": ["..."]}

Output only the JSON lines. No markdown, no prose.`;
}

interface RefactorFinding {
  title: string;
  rationale?: string;
  files?: string[];
}

function parseFindings(output: string): RefactorFinding[] {
  return output
    .split("\n")
    .filter(l => l.trim().startsWith("{"))
    .map(l => { try { return JSON.parse(l) as RefactorFinding; } catch { return null; } })
    .filter((f): f is RefactorFinding => f !== null && typeof f.title === "string");
}

export function createRefactorScanHandler(deps: RefactorScanDeps): JobHandler {
  const { runCli, command = "claude", resolveRepoPath = resolveLocalRepoPath } = deps;

  return async function refactorScanHandler(input: JobHandlerInput, ctx: JobHandlerContext) {
    const repository = typeof input.repository === "string" ? input.repository : null;
    if (!repository) throw new Error("input.repository is required");

    const repoPath = resolveRepoPath(repository);
    const cwd = repoPath ?? process.cwd();

    const prompt = buildPrompt(repository);
    const output = await runCli(command, ["-p", prompt], cwd);

    const findings = parseFindings(output);
    for (const f of findings) {
      ctx.db.createWorkItem({
        kind: "refactor",
        source: "refactor_scan",
        title: f.title,
        body: [f.rationale, f.files?.join(", ")].filter(Boolean).join("\n"),
        repository,
        priority: "medium",
      });
    }

    return {
      summary: findings.length > 0
        ? `Refactor scan of **${repository}** found ${findings.length} opportunity${findings.length !== 1 ? "ies" : ""}.`
        : `Refactor scan of **${repository}** found no refactoring opportunities.`,
    };
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd ~/agent-bridge && npm test -- tests/handlers/refactorScan.test.ts
```
Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd ~/agent-bridge && npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/agent-bridge && git add src/handlers/refactorScan.ts tests/handlers/refactorScan.test.ts
git commit -m "feat(refactor-scan): add refactorScan job handler"
```

---

### Task 4: `src/workerBot.ts` — async, repo picker, `/refactor` command

**Files:**
- Modify: `src/workerBot.ts`
- Test: `tests/workerBot.test.ts` (add new test cases)

**Interfaces:**
- Consumes:
  - `buildRepoKeyboard(ctx: string)` from `src/repoRegistry.ts`
  - `setPendingRepoBrief(chatKey, brief)` from `src/featureBriefCapture.ts`
- Changes to existing exports:
  - `handleWorkerCommand` → `async function handleWorkerCommand(...)` returns `Promise<WorkerCommandResult | null>`
  - `buildWorkerCommands()` adds `/refactor` entry
  - `isWorkerCommand()` recognises `/refactor`

- [ ] **Step 1: Write the failing tests**

Find the existing workerBot test file:
```bash
find ~/agent-bridge/tests -name "*workerBot*" 2>/dev/null
```

Add to the existing test file (or `tests/workerBot.test.ts`):

```typescript
import { vi } from "vitest";

// Mock repoRegistry before importing workerBot
vi.mock("../src/repoRegistry.js", () => ({
  buildRepoKeyboard: vi.fn().mockResolvedValue({
    inline_keyboard: [[{ text: "agent-bridge", callback_data: "rs:agent-bridge:r" }]],
  }),
  resolveGithubOwner: vi.fn().mockReturnValue("testuser"),
}));
vi.mock("../src/featureBriefCapture.js", () => ({
  setPendingFeatureBrief: vi.fn(),
  setPendingRepoBrief: vi.fn(),
  captureFeatureBrief: vi.fn().mockReturnValue(null),
  hasPendingFeatureBrief: vi.fn().mockReturnValue(false),
  clearPendingFeatureBrief: vi.fn(),
}));

import { handleWorkerCommand, isWorkerCommand, buildWorkerCommands } from "../src/workerBot.js";

describe("/refactor command", () => {
  it("is recognised as a worker command", () => {
    expect(isWorkerCommand("/refactor")).toBe(true);
    expect(isWorkerCommand("/refactor agent-bridge")).toBe(true);
  });

  it("appears in buildWorkerCommands list", () => {
    const cmds = buildWorkerCommands();
    expect(cmds.some(c => c.command === "refactor")).toBe(true);
  });

  it("returns keyboard_message with repo picker when no repo provided", async () => {
    const result = await handleWorkerCommand("/refactor", {
      workerEnabled: true,
      db: { createWorkJob: vi.fn(), listWorkJobs: vi.fn().mockReturnValue([]) } as any,
      chatId: 123,
    });
    expect(result?.kind).toBe("keyboard_message");
  });
});

describe("/review no-repo keyboard", () => {
  it("returns keyboard_message when no repo and no default", async () => {
    const result = await handleWorkerCommand("/review", {
      workerEnabled: true,
      db: { createWorkJob: vi.fn(), listWorkJobs: vi.fn().mockReturnValue([]) } as any,
      chatId: 123,
    });
    expect(result?.kind).toBe("keyboard_message");
  });
});

describe("/feature no-repo keyboard", () => {
  it("returns keyboard_message and stores pending brief when no default repo", async () => {
    const { setPendingRepoBrief } = await import("../src/featureBriefCapture.js");
    const result = await handleWorkerCommand("/feature add dark mode", {
      workerEnabled: true,
      db: { createFeaturePlan: vi.fn(), createWorkJob: vi.fn() } as any,
      chatId: 456,
    });
    expect(result?.kind).toBe("keyboard_message");
    expect(setPendingRepoBrief).toHaveBeenCalledWith("456", "add dark mode");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/agent-bridge && npm test -- tests/workerBot.test.ts 2>&1 | tail -20
```
Expected: FAIL on the new test cases.

- [ ] **Step 3: Make `handleWorkerCommand` async and add `/refactor` command**

In `src/workerBot.ts`:

**3a.** Add imports at the top:
```typescript
import { buildRepoKeyboard, resolveGithubOwner } from "./repoRegistry.js";
import { setPendingRepoBrief } from "./featureBriefCapture.js";
```

**3b.** Update `WORKER_COMMANDS` set (add `/refactor`):
```typescript
const WORKER_COMMANDS = new Set(["/jobs", "/issues", "/review", "/models", "/job", "/issue", "/feature", "/approvals", "/refactor"]);
```

**3c.** Update `buildWorkerCommands()` — add refactor entry:
```typescript
{ command: "refactor", description: "Analyse code quality: /refactor [repo]" },
```

**3d.** Update `isWorkerCommand()` — add refactor check:
```typescript
if (text.trim().toLowerCase().startsWith("/refactor ")) return true;
```

**3e.** Change `handleWorkerCommand` signature to async:
```typescript
export async function handleWorkerCommand(
  text: string,
  ctx: WorkerCommandContext,
): Promise<WorkerCommandResult | null> {
```

**3f.** Replace the `/review` no-repo block (currently returns text error) with:
```typescript
    if (!targetRepo) {
      const keyboard = await buildRepoKeyboard("r");
      if (keyboard) {
        return {
          kind: "keyboard_message",
          text: "Which repo should I scan for defects?",
          reply_markup: keyboard,
        };
      }
      return {
        kind: "message",
        text: "Which repo should I review? Use `/review <owner/repo>` or configure `WORKER_DEFAULT_REPO`.",
      };
    }
```

**3g.** Add `/refactor` handler block after the `/review` block:
```typescript
  if (cmd === "/refactor") {
    const parts = trimmed.split(/\s+/);
    const repo = parts.slice(1).join(" ").trim() || null;
    const targetRepo = repo || ctx.defaultRepo || process.env.WORKER_DEFAULT_REPO || null;
    const repoNote = targetRepo ? ` for **${targetRepo}**` : "";

    if (!ctx.workerEnabled) {
      return {
        kind: "message",
        text: `Refactor analysis${repoNote} received — worker is not yet active (WORKER_ENABLED=false).`,
      };
    }
    if (!db) {
      return { kind: "message", text: `Refactor analysis queued${repoNote}. Use /jobs to check progress.` };
    }
    if (!targetRepo) {
      const keyboard = await buildRepoKeyboard("rf");
      if (keyboard) {
        return {
          kind: "keyboard_message",
          text: "Which repo should I analyse for refactoring opportunities?",
          reply_markup: keyboard,
        };
      }
      return {
        kind: "message",
        text: "Which repo? Use `/refactor <owner/repo>` or configure `WORKER_DEFAULT_REPO`.",
      };
    }

    const activeJobs = db.listWorkJobs().filter(
      (j: any) => j.task_type === "refactor_scan" &&
           j.idempotency_key.startsWith(`refactor:${targetRepo}:`) &&
           (j.status === "pending" || j.status === "leased" || j.status === "running")
    );
    if (activeJobs.length > 0) {
      return {
        kind: "message",
        text: `Refactor scan already in progress for **${targetRepo}** (Job ID: ${activeJobs[0].id}).`,
      };
    }

    const input: Record<string, unknown> = { repository: targetRepo };
    if (ctx.chatId != null) input.notify_chat_id = ctx.chatId;

    const newJob = db.createWorkJob({
      task_type: "refactor_scan",
      idempotency_key: `refactor:${targetRepo}:${Date.now()}`,
      input_json: input,
    });

    return {
      kind: "message",
      text: `Refactor scan started for **${targetRepo}** (Job #${newJob.id}). Use /jobs to track progress.`,
    };
  }
```

**3h.** In `/feature` handler — when `db && ctx.chatId != null` and no `defaultRepo`, store brief and show keyboard:
```typescript
    if (db && ctx.chatId != null) {
      const chatKey = String(ctx.chatId);
      const userId = ctx.userId ?? "unknown";
      const defaultRepo = ctx.defaultRepo || process.env.WORKER_DEFAULT_REPO;

      if (!defaultRepo) {
        // No repo configured — store brief and show repo picker
        setPendingRepoBrief(chatKey, brief);
        const keyboard = await buildRepoKeyboard("f");
        if (keyboard) {
          return {
            kind: "keyboard_message",
            text: `Feature brief captured: **${brief}**\n\nWhich repo should this feature be built in?`,
            reply_markup: keyboard,
          };
        }
        // Registry unavailable — fall through with no repo
      }

      const plan = db.createFeaturePlan({ chatId: chatKey, userId, brief });
      const jobInput: Record<string, unknown> = {
        plan_id: plan.id,
        notify_chat_id: ctx.chatId,
        start_message: `Analysing codebase and drafting plan for **${brief}**... This takes 1–3 minutes.`,
      };
      if (defaultRepo) jobInput.repository = defaultRepo;
      db.createWorkJob({
        task_type: "feature_plan",
        idempotency_key: `feature_plan:${plan.id}`,
        input_json: jobInput,
      });
      const repoNote = defaultRepo ? `\nRepository: \`${defaultRepo}\`` : "\nRepository: `none` — set one before approval.";
      return {
        kind: "message",
        text: `Feature plan started: **${brief}**${repoNote}\n\nAnalysing the codebase and drafting an implementation plan. Use /issues to view the result when it's ready.`,
      };
    }
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd ~/agent-bridge && npm test -- tests/workerBot.test.ts
```
Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd ~/agent-bridge && npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/agent-bridge && git add src/workerBot.ts tests/workerBot.test.ts
git commit -m "feat(worker-bot): async command handler, repo picker for review/refactor/feature, /refactor command"
```

---

### Task 5: `src/workCallbacks.ts` — handle `rs:` repo-select callbacks

**Files:**
- Modify: `src/workCallbacks.ts`
- Test: `tests/workCallbacks.test.ts` (add new cases)

**Interfaces:**
- Consumes:
  - `parseRepoSelectCallback(data)` from `src/repoRegistry.ts`
  - `consumePendingRepoBrief(chatKey)` from `src/featureBriefCapture.ts`

- [ ] **Step 1: Write the failing tests**

Add to the existing workCallbacks test file (find it with `find ~/agent-bridge/tests -name "*workCallback*"`):

```typescript
import { vi } from "vitest";

vi.mock("../src/repoRegistry.js", () => ({
  parseRepoSelectCallback: (data: string) => {
    if (!data.startsWith("rs:")) return null;
    const rest = data.slice(3);
    const colon = rest.indexOf(":");
    if (colon < 1) return null;
    return { repo: rest.slice(0, colon), ctx: rest.slice(colon + 1) };
  },
}));
vi.mock("../src/featureBriefCapture.js", () => ({
  consumePendingRepoBrief: vi.fn().mockReturnValue("add dark mode"),
  setPendingFeatureBrief: vi.fn(),
}));

describe("handleWorkerCallback rs:* callbacks", () => {
  const makeCbq = (data: string, chatId = 1, msgId = 2, userId = "99") => ({
    id: "cbq1",
    data,
    from: { id: userId },
    message: { chat: { id: chatId }, message_id: msgId, text: "" },
  });

  const allowedUsers = new Set(["99"]);

  it("rs:<name>:r creates defect_scan job", async () => {
    const createWorkJob = vi.fn().mockReturnValue({ id: 42 });
    const db = { createWorkJob, listWorkJobs: vi.fn().mockReturnValue([]) } as any;
    const client = { answerCallbackQuery: vi.fn(), sendMessage: vi.fn() };
    await handleWorkerCallback(makeCbq("rs:agent-bridge:r"), db, client, allowedUsers);
    expect(createWorkJob).toHaveBeenCalledWith(
      expect.objectContaining({ task_type: "defect_scan" })
    );
    expect(client.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Defect scan queued") })
    );
  });

  it("rs:<name>:rf creates refactor_scan job", async () => {
    const createWorkJob = vi.fn().mockReturnValue({ id: 43 });
    const db = { createWorkJob, listWorkJobs: vi.fn().mockReturnValue([]) } as any;
    const client = { answerCallbackQuery: vi.fn(), sendMessage: vi.fn() };
    await handleWorkerCallback(makeCbq("rs:agent-bridge:rf"), db, client, allowedUsers);
    expect(createWorkJob).toHaveBeenCalledWith(
      expect.objectContaining({ task_type: "refactor_scan" })
    );
  });

  it("rs:<name>:f consumes pending brief and creates feature_plan job", async () => {
    const createWorkJob = vi.fn().mockReturnValue({ id: 44 });
    const createFeaturePlan = vi.fn().mockReturnValue({ id: 10 });
    const db = { createWorkJob, createFeaturePlan } as any;
    const client = { answerCallbackQuery: vi.fn(), sendMessage: vi.fn() };
    await handleWorkerCallback(makeCbq("rs:content-crawler:f", 1, 2, "99"), db, client, allowedUsers);
    expect(createFeaturePlan).toHaveBeenCalled();
    expect(createWorkJob).toHaveBeenCalledWith(
      expect.objectContaining({ task_type: "feature_plan" })
    );
  });

  it("rs:<name>:f with no pending brief answers with error text", async () => {
    const { consumePendingRepoBrief } = await import("../src/featureBriefCapture.js");
    vi.mocked(consumePendingRepoBrief).mockReturnValueOnce(null);
    const db = {} as any;
    const client = { answerCallbackQuery: vi.fn() };
    await handleWorkerCallback(makeCbq("rs:agent-bridge:f"), db, client, allowedUsers);
    expect(client.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("No pending feature") })
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/agent-bridge && npm test -- tests/workCallbacks.test.ts 2>&1 | tail -20
```
Expected: FAIL on new test cases.

- [ ] **Step 3: Add `rs:` handling to `handleWorkerCallback` in `src/workCallbacks.ts`**

Add imports at the top:
```typescript
import { parseRepoSelectCallback } from "./repoRegistry.js";
import { consumePendingRepoBrief } from "./featureBriefCapture.js";
```

In `handleWorkerCallback`, after the existing `parsePrMergeCallback` block and before the final `answerCallbackQuery`, add:

```typescript
  // Repo-select callbacks: rs:<name>:r  rs:<name>:rf  rs:<name>:f
  const repoSel = parseRepoSelectCallback(cbq.data || "");
  if (repoSel) {
    const { repo, ctx: selCtx } = repoSel;
    const owner = process.env.GITHUB_USERNAME ? `${process.env.GITHUB_USERNAME}/${repo}` : repo;

    if (selCtx === "r") {
      db.createWorkJob({
        task_type: "defect_scan",
        idempotency_key: `scan:${owner}:${Date.now()}`,
        input_json: { repository: owner, ...(chatId != null ? { notify_chat_id: chatId } : {}) },
      });
      await client.answerCallbackQuery({
        callback_query_id: cbq.id,
        text: `Defect scan queued for ${repo}.`,
      });
      return;
    }

    if (selCtx === "rf") {
      db.createWorkJob({
        task_type: "refactor_scan",
        idempotency_key: `refactor:${owner}:${Date.now()}`,
        input_json: { repository: owner, ...(chatId != null ? { notify_chat_id: chatId } : {}) },
      });
      await client.answerCallbackQuery({
        callback_query_id: cbq.id,
        text: `Refactor scan queued for ${repo}.`,
      });
      return;
    }

    if (selCtx === "f") {
      const brief = consumePendingRepoBrief(String(chatId));
      if (!brief) {
        await client.answerCallbackQuery({
          callback_query_id: cbq.id,
          text: "No pending feature brief — use /feature first.",
        });
        return;
      }
      const plan = db.createFeaturePlan({ chatId: String(chatId), userId, brief });
      db.createWorkJob({
        task_type: "feature_plan",
        idempotency_key: `feature_plan:${plan.id}`,
        input_json: {
          plan_id: plan.id,
          repository: owner,
          notify_chat_id: chatId,
          start_message: `Analysing codebase and drafting plan for **${brief}**... This takes 1–3 minutes.`,
        },
      });
      await client.answerCallbackQuery({
        callback_query_id: cbq.id,
        text: `Feature plan started for ${repo}.`,
      });
      return;
    }

    await client.answerCallbackQuery({ callback_query_id: cbq.id });
    return;
  }
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd ~/agent-bridge && npm test -- tests/workCallbacks.test.ts
```
Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
cd ~/agent-bridge && npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/agent-bridge && git add src/workCallbacks.ts tests/workCallbacks.test.ts
git commit -m "feat(callbacks): handle rs:* repo-select callbacks for scan/refactor/feature"
```

---

### Task 6: `src/jobExecutor.ts` — silence transient failures

**Files:**
- Modify: `src/jobExecutor.ts`
- Test: `tests/jobExecutor.test.ts` (add new cases)

**Goal:** Transient failures (retry attempts remaining) → no `notify()` call. Permanent failures → one clean `notify()` with truncated message. Repair job queuing → silent (no notify).

- [ ] **Step 1: Write the failing tests**

Find existing test: `find ~/agent-bridge/tests -name "*jobExecutor*"`.

Add new test cases:

```typescript
describe("failure notification silencing", () => {
  it("does not call notify on transient failure when retries remain", async () => {
    const notify = vi.fn();
    const db = makeMockDb({ maxAttempts: 3, attemptCount: 1 });
    db.failWorkJob.mockImplementation(() => undefined);
    const handlers = {
      "failing_task": vi.fn().mockRejectedValue(new Error("transient error")),
    };
    await executeNextJob({ db, workerId: "w1", handlers, notify });
    expect(notify).not.toHaveBeenCalled();
  });

  it("calls notify exactly once on permanent failure", async () => {
    const notify = vi.fn();
    const db = makeMockDb({ maxAttempts: 1, attemptCount: 1 });
    db.failWorkJobPermanently.mockImplementation(() => undefined);
    const handlers = {
      "failing_task": vi.fn().mockRejectedValue(new Error("permanent error")),
    };
    await executeNextJob({ db, workerId: "w1", handlers, notify });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("failed permanently");
  });
});
```

(Note: `makeMockDb` is a helper already present in the existing test file — adapt as needed for the actual test structure.)

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/agent-bridge && npm test -- tests/jobExecutor.test.ts 2>&1 | tail -20
```
Expected: FAIL on new cases.

- [ ] **Step 3: Modify `src/jobExecutor.ts`**

Find the failure-notification lines (around line 115–168). Change from:

```typescript
    // Current: always notifies
    await notify(`Job #${job.id} failed: ${message}`);
    if (repair) await notify(`Repair job #${repair.id} queued for failed job #${job.id}.`);
```

To (for transient):
```typescript
    // Transient — orchestrator retries; do not surface to user
    db.failWorkJob(job.id, message, workerId);
    // No notify — repair is enqueued silently
    if (repair) { /* silent */ }
```

And for permanent:
```typescript
    db.failWorkJobPermanently(job.id, message, workerId);
    await notify(`Job #${job.id} failed permanently: ${message.slice(0, 200)}`);
    // Repair not applicable for permanent failures
```

The exact edit depends on the current conditional structure. Read the current `jobExecutor.ts` failure block carefully before editing. The key invariant: **`notify` is called only when `isPermanent === true`**.

- [ ] **Step 4: Run tests to verify pass**

```bash
cd ~/agent-bridge && npm test -- tests/jobExecutor.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/agent-bridge && git add src/jobExecutor.ts tests/jobExecutor.test.ts
git commit -m "fix(job-executor): silence transient failures; notify only on permanent failure"
```

---

### Task 7: `src/handlers/` — replace hardcoded `nickconstantinou` with `GITHUB_USERNAME`

**Files:**
- Modify: `src/handlers/githubIssue.ts:31`
- Modify: `src/handlers/prLifecycle.ts:100`
- Modify: `src/handlers/prWatch.ts:91`

**No new tests needed** — existing tests cover these handlers; only the owner resolution changes.

- [ ] **Step 1: Edit `src/handlers/githubIssue.ts`**

Replace:
```typescript
    const repository = rawRepository && !rawRepository.includes("/") ? `nickconstantinou/${rawRepository}` : rawRepository;
```
With:
```typescript
    const owner = process.env.GITHUB_USERNAME || "nickconstantinou";
    const repository = rawRepository && !rawRepository.includes("/") ? `${owner}/${rawRepository}` : rawRepository;
```

- [ ] **Step 2: Edit `src/handlers/prLifecycle.ts`**

Replace the equivalent `nickconstantinou` line (around line 100):
```typescript
    const owner = process.env.GITHUB_USERNAME || "nickconstantinou";
    const repository = rawRepository && !rawRepository.includes("/") ? `${owner}/${rawRepository}` : rawRepository;
```

- [ ] **Step 3: Edit `src/handlers/prWatch.ts`**

Replace the equivalent line (around line 91):
```typescript
    const owner = process.env.GITHUB_USERNAME || "nickconstantinou";
    // ...use `${owner}/${link.repository}` in the gh command args
    "--repo", link.repository.includes("/") ? link.repository : `${owner}/${link.repository}`,
```

- [ ] **Step 4: Typecheck and full suite**

```bash
cd ~/agent-bridge && npm run typecheck && npm test
```
Expected: no type errors; all tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/agent-bridge && git add src/handlers/githubIssue.ts src/handlers/prLifecycle.ts src/handlers/prWatch.ts
git commit -m "fix(handlers): replace hardcoded nickconstantinou with GITHUB_USERNAME env var"
```

---

### Task 8: `src/index-worker.ts` — wire async handler and register `refactor_scan`

**Files:**
- Modify: `src/index-worker.ts`

- [ ] **Step 1: No separate test needed** — integration covered by full suite; just make the changes compile.

- [ ] **Step 2: Add `await` to both `handleWorkerCommand` calls**

At line ~394:
```typescript
const result = await handleWorkerCommand(rawText, { workerEnabled, cliChain, db, chatId, userId, defaultRepo: process.env.WORKER_DEFAULT_REPO });
```

At line ~407:
```typescript
const briefResult = await handleWorkerCommand(`/feature ${capturedBrief}`, { workerEnabled, cliChain, db, chatId, userId, defaultRepo: process.env.WORKER_DEFAULT_REPO });
```

- [ ] **Step 3: Import and register `refactor_scan` handler**

Add import near the other handler imports:
```typescript
import { createRefactorScanHandler } from "./handlers/refactorScan.js";
```

In the handlers object (near `defect_scan`):
```typescript
    refactor_scan: createRefactorScanHandler({
      runCli: (cmd, args, cwd) => runCliWithFallback(cmd, args, cwd ?? process.cwd(), scribeCliChain, { effort: workerEffortForTask("defect_scan") }),
      resolveRepoPath: (r) => resolveLocalRepoPath(r),
    }),
```

- [ ] **Step 4: Typecheck and full suite**

```bash
cd ~/agent-bridge && npm run typecheck && npm test
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd ~/agent-bridge && git add src/index-worker.ts
git commit -m "feat(worker): await async handleWorkerCommand; register refactor_scan handler"
```

---

### Task 9: Installer and env example

**Files:**
- Modify: `scripts/install.sh`
- Modify: `.env.worker.example`

- [ ] **Step 1: Update `.env.worker.example`**

Add after `WORKER_DEFAULT_REPO=agent-bridge`:
```
# GitHub username — used to prefix bare repo names (e.g. "agent-bridge" → "username/agent-bridge")
GITHUB_USERNAME=
```

- [ ] **Step 2: Add worker section to `scripts/install.sh`**

Find the block that writes the shared env file (around line 170–195). After the existing prompts and before the file-write section, add:

```bash
# Worker bot section
prompt TELEGRAM_BOT_TOKEN_WORKER  "Worker bot token (leave blank to skip)" ""
if [[ -n "${TELEGRAM_BOT_TOKEN_WORKER:-}" ]]; then
  prompt GITHUB_USERNAME     "GitHub username for worker repo picker"       ""
  prompt WORKER_DEFAULT_REPO "Default repo for scans (short name, e.g. agent-bridge)" "agent-bridge"
  prompt WORKER_ENABLED      "Enable worker bot on start (true|false)"      "false"
fi
```

And in the file-write section, write `.env.worker` when the token is set:

```bash
if [[ -n "${TELEGRAM_BOT_TOKEN_WORKER:-}" ]]; then
  write_env_file "${TARGET_HOME}/agent-bridge/.env.worker" \
    TELEGRAM_BOT_TOKEN_WORKER \
    GITHUB_USERNAME \
    WORKER_DEFAULT_REPO \
    WORKER_ENABLED
fi
```

(Follow the exact pattern used in `install.sh` for other `.env.*` files — inspect lines 200–300 to match the existing `write_env_file` call style.)

- [ ] **Step 3: Typecheck (N/A for shell) + full test suite**

```bash
cd ~/agent-bridge && npm run typecheck && npm test
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd ~/agent-bridge && git add scripts/install.sh .env.worker.example
git commit -m "feat(install): add worker section; prompt GITHUB_USERNAME, WORKER_DEFAULT_REPO, WORKER_ENABLED"
```

---

### Task 10: Final integration — full suite + deploy

- [ ] **Step 1: Run full test suite**

```bash
cd ~/agent-bridge && npm test
```
Expected: all tests pass (was 1160+ before this feature).

- [ ] **Step 2: Typecheck**

```bash
cd ~/agent-bridge && npm run typecheck
```
Expected: 0 errors.

- [ ] **Step 3: Set `GITHUB_USERNAME` in live `.env.worker`**

```bash
grep "GITHUB_USERNAME" ~/agent-bridge/.env.worker || echo "GITHUB_USERNAME=nickconstantinou" >> ~/agent-bridge/.env.worker
```

- [ ] **Step 4: Safe restart worker bot**

```bash
systemctl --user restart agent-bridge-worker-bot.service
sleep 3
systemctl --user is-active agent-bridge-worker-bot.service
```
Expected: `active`.

- [ ] **Step 5: Smoke test in Telegram**

Send `/review` with no arg → expect repo keyboard with your GitHub repos.  
Send `/refactor` → expect repo keyboard.  
Send `/feature test the picker` → expect repo keyboard with brief confirmation.  
Click a repo button → expect job queued confirmation.

- [ ] **Step 6: Final commit if any fixups needed, then push**

```bash
cd ~/agent-bridge && git push
```
