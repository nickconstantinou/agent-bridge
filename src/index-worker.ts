/**
 * PURPOSE: Entry point for the autonomous worker bot.
 * Handles /jobs, /issues, /review, /models commands. Routes plain messages
 * to the active CLI engine via a fallback chain (codex → claude → antigravity).
 * When a CLI is at capacity, the chain advances and retries with the next CLI,
 * injecting the last 3 turns as context.
 * NEIGHBORS: src/workerBot.ts, src/engine.ts, src/workerFallback.ts, src/workerDispatch.ts
 */

import dotenv from "dotenv";
import {
  getBridgeProjectDir,
  openDb,
  isAuthorizedMessage,
  shutdownCliProcesses,
  parseModelPreference,
} from "./bridge.js";
import { TelegramClient } from "./telegram.js";
import { BridgeEngine } from "./engine.js";
import { sendTelegramMessage } from "./messageDelivery.js";
import { handleWorkerCommand, isWorkerCommand, buildWorkerCommands } from "./workerBot.js";
import { WorkerFallbackChain } from "./workerFallback.js";
import { dispatchWithFallback, runCliWithFallback } from "./workerDispatch.js";
import { handleWorkerCallback } from "./workCallbacks.js";
import { startJobExecutorLoop } from "./jobExecutorLoop.js";
import { createDefectScanHandler } from "./handlers/defectScan.js";
import { createFeaturePlanHandler } from "./handlers/featurePlan.js";
import { createGithubIssueHandler } from "./handlers/githubIssue.js";
import { createTddImplementationHandler } from "./handlers/tddImplementation.js";
import { createPrLifecycleHandler } from "./handlers/prLifecycle.js";
import { createPrWatchHandler } from "./handlers/prWatch.js";
import { createPrRefreshHandler } from "./handlers/prRefresh.js";
import { captureFeatureBrief } from "./featureBriefCapture.js";
import { runCli } from "./cli.js";
import { createRunCommand } from "./runCommandAsync.js";
import { prepareWorkspace, createWorkspaceCleanup, resolveLocalRepoPath } from "./workspace.js";
import type { BridgeConfig, BotKind, TelegramUpdate } from "./types.js";

dotenv.config({
  path: process.env.BRIDGE_ENV_FILE || ".env.worker",
  override: false,
});

const token = process.env.TELEGRAM_BOT_TOKEN_WORKER;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN_WORKER is required");

const allowedUserIds = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USER_ID || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);

const workerEnabled = process.env.WORKER_ENABLED === "true";
const jobPollIntervalMs = Number(process.env.WORKER_JOB_POLL_INTERVAL_MS || 10_000);
const prWatchIntervalMs = Number(process.env.WORKER_PR_WATCH_INTERVAL || 3_600_000); // 1h default
const prStaleHours = Number(process.env.WORKER_PR_STALE_HOURS || 72);
const defectScanCommand = process.env.DEFECT_SCAN_CLI_COMMAND || "claude";
const cliChain = (process.env.WORKER_CLI_CHAIN || "codex,claude,antigravity")
  .split(",").map(s => s.trim()).filter(Boolean);
const dbPath = process.env.DB_PATH || `${getBridgeProjectDir()}/.data/bridge.sqlite`;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 1000);
const executionMode = (process.env.BRIDGE_EXECUTION_MODE as "safe" | "trusted") || "safe";
const asyncEnabled = process.env.BRIDGE_ASYNC_ENABLED !== "false";

const db = openDb(dbPath);
const client = new TelegramClient(token, fetch, 45_000);

// ── Fallback chain state (shared across all dispatches) ───────────────────────

const fallbackChain = new WorkerFallbackChain(cliChain);
const exhaustedChats = new Set<string>();
// contextPreambles: set by dispatchWithFallback before retry; consumed + deleted by onBeforeExecute
const contextPreambles = new Map<string, string>();

// ── Bridge config ─────────────────────────────────────────────────────────────

const config: BridgeConfig = {
  allowedUserIds,
  serviceEnvFile: process.env.BRIDGE_ENV_FILE || null,
  serviceKind: null,
  pollIntervalMs,
  executionMode,
  asyncEnabled,
  dbPath,
  bots: {
    codex: {
      token: undefined,
      command: process.env.CODEX_COMMAND || "codex",
      modelPreference: parseModelPreference(process.env.CODEX_MODEL_PREFERENCE),
    },
    antigravity: {
      token: undefined,
      command: process.env.ANTIGRAVITY_COMMAND || "agy",
      modelPreference: parseModelPreference(process.env.ANTIGRAVITY_MODEL_PREFERENCE),
    },
    claude: {
      token: undefined,
      command: process.env.CLAUDE_COMMAND || "claude",
      modelPreference: parseModelPreference(process.env.CLAUDE_MODEL_PREFERENCE),
    },
  },
};

// ── Build one engine per CLI kind ─────────────────────────────────────────────

const CLI_KINDS = ["codex", "claude", "antigravity"] as const;
const engines = Object.fromEntries(
  CLI_KINDS.map((kind) => {
    const botConfig = config.bots[kind as BotKind];
    return [
      kind,
      new BridgeEngine(
        {
          kind,
          botConfig: { ...botConfig, token },
          allowedUserIds,
          executionMode,
          asyncEnabled,
          pollIntervalMs,
          fullConfig: config,
          hooks: {
            onCapacityExhausted: async (chatKey: string) => {
              exhaustedChats.add(chatKey);
            },
            onBeforeExecute: async (prompt: string, ctx: { chatKey: string }) => {
              const preamble = contextPreambles.get(ctx.chatKey);
              if (preamble) {
                contextPreambles.delete(ctx.chatKey);
                return preamble + prompt;
              }
              return prompt;
            },
          },
        },
        db,
        client,
      ),
    ];
  }),
) as Record<string, BridgeEngine>;

// ── setMyCommands ─────────────────────────────────────────────────────────────

await client.setMyCommands({ commands: buildWorkerCommands() })
  .catch((err: unknown) => console.warn("[worker-bot] setMyCommands failed", err));

// ── Background job executor loop ──────────────────────────────────────────────

// Async runner: keeps the polling loop responsive during git/gh/npm children
// and loads GH_TOKEN from the secrets file for gh API calls.
const runWorkerCommand = createRunCommand({ loadGhToken: true });

// Per-job workspaces: implementation jobs clone the local checkout instead of
// mutating it in place. Cleanup only ever deletes inside the workspace base.
const cleanupWorkspace = createWorkspaceCleanup();

// Test runner returning pass/fail rather than throwing — the TDD handler
// needs a red run to fail and a green run to pass.
const runTests = async (cwd: string): Promise<{ ok: boolean; output: string }> => {
  try {
    const output = await runWorkerCommand("npm", ["test"], { cwd });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, output: err instanceof Error ? err.message : String(err) };
  }
};

const jobExecutor = startJobExecutorLoop({
  db,
  workerId: `worker-bot-${process.pid}`,
  handlers: {
    defect_scan: createDefectScanHandler({
      runCli: (cmd, args, cwd) => runCliWithFallback(cmd, args, cwd ?? process.cwd(), cliChain),
      command: defectScanCommand,
      resolveRepoPath: (repository) => resolveLocalRepoPath(repository),
    }),
    feature_plan: createFeaturePlanHandler({
      runCli: (cmd, args, cwd) => runCliWithFallback(cmd, args, cwd ?? process.cwd(), cliChain, { timeoutMs: 20 * 60 * 1000 }),
      command: defectScanCommand,
    }),
    tdd_implementation: createTddImplementationHandler({
      runCli: (cmd, args, cwd) => runCliWithFallback(cmd, args, cwd ?? process.cwd(), cliChain, { timeoutMs: 15 * 60 * 1000 }),
      command: defectScanCommand,
      // File edits only — bash stays gated; the handler runs tests itself
      cliExtraArgs: ["--permission-mode", "acceptEdits"],
      runGit: (args, cwd) => runWorkerCommand("git", args, { cwd }),
      runTests,
      prepareWorkspace: (repository, workItemId) => prepareWorkspace({
        repository,
        workItemId,
        // --include=dev: the service runs with NODE_ENV=production, which would
        // otherwise omit devDependencies — and the test runner lives there
        installDeps: (dir) => runWorkerCommand("npm", ["ci", "--no-audit", "--no-fund", "--include=dev"], { cwd: dir }).then(() => undefined),
      }),
      cleanupWorkspace,
    }),
    open_github_issue: createGithubIssueHandler({
      runCommand: (binary, args) => runWorkerCommand(binary, args),
    }),
    pr_lifecycle: createPrLifecycleHandler({
      runGit: (args, cwd) => runWorkerCommand("git", args, { cwd }),
      runCommand: (binary, args) => runWorkerCommand(binary, args),
      cleanupWorkspace,
      maxOpenPrs: Number(process.env.WORKER_MAX_OPEN_PRS || 3),
      maxDailyPrs: Number(process.env.WORKER_MAX_DAILY_PRS || 3),
    }),
    pr_watch: createPrWatchHandler({
      runCommand: (binary, args) => runWorkerCommand(binary, args),
      staleHours: prStaleHours,
      notifyStale: async (stalePrs) => {
        const notifyChatId = Number(process.env.WORKER_NOTIFY_CHAT_ID);
        if (!notifyChatId) return;
        const lines = stalePrs.map(p =>
          `PR #${p.pr_number} in \`${p.repository}\` is stale`
        ).join("\n");
        const buttons = stalePrs.map(p => [
          { text: "🔄 Refresh", callback_data: `pr:${p.id}:rfsh` },
          { text: "⏸ Hold", callback_data: `pr:${p.id}:hold` },
          { text: "✗ Close", callback_data: `pr:${p.id}:clse` },
        ]);
        await sendTelegramMessage({
          client, kind: "worker-bot", chatId: notifyChatId,
          body: { text: `Stale PR digest:\n${lines}`, reply_markup: { inline_keyboard: buttons } },
        });
      },
    }),
    pr_refresh: createPrRefreshHandler({
      runGit: (args, cwd) => runWorkerCommand("git", args, { cwd }),
      runCommand: (binary, args) => runWorkerCommand(binary, args),
      runTests,
      cleanupWorkspace,
    }),
  },
  sendMessage: async (chatId: number, text: string, replyMarkup?: object) => {
    const body: any = { text };
    if (replyMarkup) body.reply_markup = replyMarkup;
    await sendTelegramMessage({ client, kind: "worker-bot", chatId, body });
  },
  intervalMs: jobPollIntervalMs,
});

let shouldExit = false;

const handleShutdown = () => {
  console.log("[worker-bot] SIGTERM/SIGINT received. Stopping job claims...");
  shouldExit = true;
  jobExecutor.stop();

  const checkExit = () => {
    if (jobExecutor.isIdle()) {
      console.log("[worker-bot] Idle. Exiting process.");
      process.exit(0);
    } else {
      console.log("[worker-bot] Job in progress. Waiting to exit...");
      setTimeout(checkExit, 1000);
    }
  };
  checkExit();
};

process.once("SIGTERM", handleShutdown);
process.once("SIGINT", handleShutdown);

// Enqueue a pr_watch job once per hour (idempotency key prevents duplicates within the window)
function enqueuePrWatch() {
  const dateHour = new Date().toISOString().slice(0, 13); // e.g. "2026-06-11T19"
  db.createWorkJob({ task_type: "pr_watch", idempotency_key: `pr_watch:${dateHour}`, max_attempts: 1 });
}
enqueuePrWatch();
setInterval(enqueuePrWatch, prWatchIntervalMs);

console.log(`[worker-bot] starting (workerEnabled=${workerEnabled}, cliChain=${cliChain.join(",")}, jobPollIntervalMs=${jobPollIntervalMs})`);

let offset = 0;

for (;;) {
  if (shouldExit) break;
  try {
    const updates = await client.getUpdates({ offset, timeout: 30, allowed_updates: ["message", "callback_query"] });

    for (const update of (updates.result as any) ?? []) {
      const updateId: number = update.update_id;
      offset = updateId + 1;

      try {
        const callbackQuery = update.callback_query;
        if (callbackQuery) {
          await handleWorkerCallback(callbackQuery, db, client, allowedUserIds);
          continue;
        }

        const message = (update as TelegramUpdate).message;
        if (!message) continue;
        if (!isAuthorizedMessage(message, allowedUserIds)) continue;

        const rawText = (message.text || "").trim();
        const chatId = message.chat.id;
        const chatKey = String(chatId);
        const userId = message.from ? String(message.from.id) : "unknown";

        // Worker commands (/jobs, /issues, /review, /feature, /models) take priority
        if (isWorkerCommand(rawText)) {
          const result = handleWorkerCommand(rawText, { workerEnabled, cliChain, db, chatId, userId, defaultRepo: process.env.WORKER_DEFAULT_REPO });
          if (result) {
            const body = result.kind === "keyboard_message"
              ? { text: result.text, reply_markup: result.reply_markup }
              : { text: result.text };
            await sendTelegramMessage({ client, kind: "worker-bot", chatId, body });
          }
          continue;
        }

        // Check if this plain message is a pending feature brief
        const capturedBrief = captureFeatureBrief(chatKey, rawText);
        if (capturedBrief) {
          const briefResult = handleWorkerCommand(`/feature ${capturedBrief}`, { workerEnabled, cliChain, db, chatId, userId });
          if (briefResult) {
            const body = briefResult.kind === "keyboard_message"
              ? { text: briefResult.text, reply_markup: briefResult.reply_markup }
              : { text: briefResult.text };
            await sendTelegramMessage({ client, kind: "worker-bot", chatId, body });
          }
          continue;
        }

        // Plain message — record user turn, route to active CLI with fallback
        fallbackChain.addTurn(chatKey, "user", rawText);

        await dispatchWithFallback(update as TelegramUpdate, chatKey, {
          engines,
          fallbackChain,
          exhaustedChats,
          contextPreambles,
          notify: async (msg: string) => {
            await sendTelegramMessage({ client, kind: "worker-bot", chatId, body: { text: msg } });
          },
        });
      } catch (err) {
        console.error("[worker-bot] update handling failed", err);
      }
    }
  } catch (err) {
    console.error("[worker-bot] poll error", err);
    await new Promise(r => setTimeout(r, 5000));
  }
}
