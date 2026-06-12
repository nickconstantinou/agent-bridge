import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const CUTOFF_DATE = "2026-06-12T17:06:19Z"; // Commit 5bedd07

interface RunStats {
  runId: string;
  bot: string;
  startedAt: string;
  promptChars: number | null;
  responseChars: number;
}

function getPromptCharsFromJournal(days: number): Map<string, number> {
  const runIdToPromptChars = new Map<string, number>();
  const pidToPromptChars = new Map<string, number>();

  try {
    const services = [
      "agent-bridge-antigravity.service",
      "agent-bridge-claude.service",
      "agent-bridge-codex.service"
    ];
    const serviceFlags = services.map(s => `-u ${s}`).join(" ");
    
    // Fetch journal logs
    const output = execSync(
      `journalctl ${serviceFlags} --no-pager --since "${days} days ago"`,
      { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 }
    );

    const lines = output.split("\n");
    for (const line of lines) {
      const pidMatch = line.match(/env\[(\d+)\]/);
      if (!pidMatch) continue;
      const pid = pidMatch[1];

      // Match [spawn] line
      const spawnMatch = line.match(/\[spawn\].*\[prompt:\s+(\d+)chars\]/);
      if (spawnMatch) {
        const chars = parseInt(spawnMatch[1], 10);
        pidToPromptChars.set(pid, chars);
        continue;
      }

      // Match run.started line
      const startedMatch = line.match(/run\.started\s+runId=([a-f0-9\-]+)/);
      if (startedMatch) {
        const runId = startedMatch[1];
        const chars = pidToPromptChars.get(pid);
        if (chars !== undefined) {
          runIdToPromptChars.set(runId, chars);
        }
      }
    }
  } catch (err) {
    console.error("Error fetching journal logs:", err);
  }

  return runIdToPromptChars;
}

function main() {
  const days = 7;
  console.log(`Scanning systemd logs for the last ${days} days...`);
  const runIdToPromptChars = getPromptCharsFromJournal(days);
  console.log(`Found prompt length mapping for ${runIdToPromptChars.size} runs in systemd logs.`);

  const bots = ["antigravity", "claude", "codex"];
  const dbPaths = bots.map(bot => `/home/content-crawler/agent-bridge/.data-${bot}/bridge.sqlite`);

  const allRuns: RunStats[] = [];

  for (let i = 0; i < bots.length; i++) {
    const bot = bots[i];
    const dbPath = dbPaths[i];

    if (!existsSync(dbPath)) {
      continue;
    }

    try {
      const db = new Database(dbPath);
      const rows = db.prepare(
        `SELECT run_id, started_at, final_text_preview FROM bridge_runs WHERE status = 'done'`
      ).all() as { run_id: string; started_at: string; final_text_preview: string | null }[];

      for (const row of rows) {
        const responseText = row.final_text_preview || "";
        const promptChars = runIdToPromptChars.get(row.run_id) || null;

        allRuns.push({
          runId: row.run_id,
          bot,
          startedAt: row.started_at,
          promptChars,
          responseChars: responseText.length,
        });
      }
      db.close();
    } catch (err) {
      console.error(`Error reading database ${dbPath}:`, err);
    }
  }

  // Segment runs into Before and After
  const beforeRuns = allRuns.filter(r => r.startedAt < CUTOFF_DATE);
  const afterRuns = allRuns.filter(r => r.startedAt >= CUTOFF_DATE);

  // We only include runs where we have both prompt and response sizes to ensure fair averages.
  const beforeWithPrompt = beforeRuns.filter(r => r.promptChars !== null);
  const afterWithPrompt = afterRuns.filter(r => r.promptChars !== null);

  console.log("\n=== TOKEN SAVINGS AUDIT ===");
  console.log(`Cutoff Time (Variant B applied): ${CUTOFF_DATE}\n`);

  console.log(`Baseline (Before Cutoff) Completed Runs: ${beforeRuns.length} (with prompt data: ${beforeWithPrompt.length})`);
  console.log(`Optimized (After Cutoff) Completed Runs: ${afterRuns.length} (with prompt data: ${afterWithPrompt.length})\n`);

  if (beforeWithPrompt.length === 0) {
    console.log("No baseline runs with prompt data found.");
    return;
  }

  const avgBeforePrompt = beforeWithPrompt.reduce((sum, r) => sum + r.promptChars!, 0) / beforeWithPrompt.length;
  const avgBeforeResponse = beforeWithPrompt.reduce((sum, r) => sum + r.responseChars, 0) / beforeWithPrompt.length;
  const avgBeforeTotal = avgBeforePrompt + avgBeforeResponse;

  console.log("BASELINE AVERAGES (Before):");
  console.log(`- Prompt Chars:   ${avgBeforePrompt.toFixed(1)} (~${Math.round(avgBeforePrompt/4)} tokens)`);
  console.log(`- Response Chars: ${avgBeforeResponse.toFixed(1)} (~${Math.round(avgBeforeResponse/4)} tokens)`);
  console.log(`- Total Chars:    ${avgBeforeTotal.toFixed(1)} (~${Math.round(avgBeforeTotal/4)} tokens)\n`);

  if (afterWithPrompt.length === 0) {
    console.log("No optimized runs with prompt data found.");
    return;
  }

  const avgAfterPrompt = afterWithPrompt.reduce((sum, r) => sum + r.promptChars!, 0) / afterWithPrompt.length;
  const avgAfterResponse = afterWithPrompt.reduce((sum, r) => sum + r.responseChars, 0) / afterWithPrompt.length;
  const avgAfterTotal = avgAfterPrompt + avgAfterResponse;

  console.log("OPTIMIZED AVERAGES (After):");
  console.log(`- Prompt Chars:   ${avgAfterPrompt.toFixed(1)} (~${Math.round(avgAfterPrompt/4)} tokens)`);
  console.log(`- Response Chars: ${avgAfterResponse.toFixed(1)} (~${Math.round(avgAfterResponse/4)} tokens)`);
  console.log(`- Total Chars:    ${avgAfterTotal.toFixed(1)} (~${Math.round(avgAfterTotal/4)} tokens)\n`);

  const diffPrompt = avgAfterPrompt - avgBeforePrompt;
  const diffResponse = avgBeforeResponse - avgAfterResponse;
  const netSavedChars = diffResponse - diffPrompt;
  const netSavedTokens = netSavedChars / 4;

  console.log("SAVINGS SUMMARY PER RUN:");
  console.log(`- Prompt Overhead:   ${diffPrompt.toFixed(1)} chars (${diffPrompt >= 0 ? '+' : ''}${Math.round(diffPrompt/4)} tokens)`);
  console.log(`- Response Reduction: ${diffResponse.toFixed(1)} chars (~${Math.round(diffResponse/4)} tokens)`);
  console.log(`- Net Saved Chars:    ${netSavedChars.toFixed(1)} chars`);
  console.log(`- Net Saved Tokens:   ~${Math.round(netSavedTokens)} tokens`);
  console.log(`- Reduction %:        ${((netSavedChars / avgBeforeTotal) * 100).toFixed(1)}%\n`);

  const totalRunsAfter = afterRuns.length;
  const totalSavedTokens = netSavedTokens * totalRunsAfter;

  console.log("TOTAL ESTIMATED SAVINGS FOR OPTIMIZED PERIOD:");
  console.log(`- Total Completed Runs: ${totalRunsAfter}`);
  console.log(`- Estimated Net Tokens Saved: ~${Math.round(totalSavedTokens)} tokens`);
}

main();
