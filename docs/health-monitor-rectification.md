# Health Monitor Rectification Plan

Health monitoring was disabled on 2026-06-02 (`HEALTH_MONITOR_ENABLED=false` in `.env.shared`) pending these fixes. Re-enable once all high-severity items are resolved.

## Issues by Severity

### High — fix before re-enabling

**1. `ExternalPlugin` blocks the event loop (`plugins/external.ts:18`)**

`spawnSync` with a 30s timeout freezes all Node.js I/O — Telegram polling, message delivery, everything — while the health script runs. Replace with async `spawn` (or `execFile` via `util.promisify`).

**2. `generateSuggestion` forwards agy error strings verbatim (`suggest.ts:43`)**

`result.text.trim() || null` returns whatever the CLI writes to stdout, including `Error: timed out waiting for response`. The scheduler forwards it to the user prefixed with `💡 *Suggested actions:*`. Add a guard that detects error-shaped responses and returns `null` instead.

Root cause chain (documented 2026-06-02): old `SUGGEST_TIMEOUT_MS = 120_000` caused bridge to SIGTERM agy at 120s → agy output its internal timeout string → scheduler forwarded it verbatim. `SUGGEST_TIMEOUT_MS` was raised to `600_000` as a partial fix, but the string-forwarding bug remains latent.

---

### Medium — fix before re-enabling

**3. No concurrency guard in `HealthScheduler` (`scheduler.ts:35`)**

`setInterval` fires regardless of whether the previous run is still in flight. A suggest call can take up to 10 minutes (600s); if a run overlaps with the next interval there will be concurrent CLI spawns. Add an in-flight flag and skip the interval tick if the previous run hasn't finished.

**4. Plugin registration log fires even when health is disabled (`index.ts:718–728`)**

`[health] content-crawler plugin enabled` is logged unconditionally, even when `HEALTH_MONITOR_ENABLED=false`. Guard the plugin registration block behind `if (healthEnabled)` so startup logs accurately reflect runtime state.

**5. Agy's internal print-mode timeout (~2 min) is shorter than `SUGGEST_TIMEOUT_MS` (10 min)**

Agy's 587-poll limit (~117s) is fixed in the binary. Raising the bridge timeout stops premature SIGTERM but can't extend agy's own limit. For complex health investigations agy will still time out internally and emit the error string (bug 2 above). Consider a shorter, more focused suggestion prompt to keep agy within its limit.

---

### Low — fix at convenience

**6. `HealthConfig.reportChatId` is dead code**

The chat ID is wired via the `sendReport` callback in `index.ts`; this field on the config interface is never read. Remove to avoid confusion.

**7. `AutonomyLevel "auto"` has no distinct behaviour**

`scheduler.ts:54` treats `"auto"` identically to `"suggest"`. Either implement distinct behaviour or remove the value from the type.

**8. `SelfPlugin` DB liveness check hardcodes `"codex"` (`self.ts:28`)**

`getLastUpdateId("codex")` is called regardless of which bots are running. Use whichever bot kind is actually active, or use a bot-agnostic read.

**9. `formatReport` italic summary can break on underscores (`reporter.ts:9`)**

Telegram Markdown italics use `_text_`; a summary containing `_` will corrupt the formatting. Escape underscores or switch to MarkdownV2.

---

## Re-enable Checklist

- [x] Fix `ExternalPlugin` to use async spawn (issue 1)
- [x] Filter error-string responses in `generateSuggestion` (issue 2)
- [x] Add in-flight guard to `HealthScheduler` (issue 3)
- [x] Guard plugin registration behind `healthEnabled` in `index.ts` (issue 4)
- [x] Shorten/focus the suggestion prompt so agy completes within ~90s (issue 5)
- [x] Set `HEALTH_MONITOR_ENABLED=true` in `.env.shared` and restart Claude bridge
- [ ] Monitor first two cycles manually before leaving unattended
