# Agy Compact Parsing Fix Implementation Plan

Date: 2026-07-08
Issue: TBD

## Problem

`/compact` fails when the active CLI is Antigravity/Agy because the compaction path parses raw CLI stdout directly.

Observed user-facing failure:

```text
Compaction failed — conversation history was left unchanged. You can try /compact again or keep working normally.
```

Likely internal error:

```text
invalid compact JSON output
```

Agy stdout is wrapped as:

```json
{"reasoning":"...","response":"..."}
```

The inner `response` field contains the final user-facing payload. For compaction, that response should contain the compact JSON:

```json
{"summary_md":"...","memory_candidates":[]}
```

Today, `compactConversation` passes the raw outer Agy JSON to `parseCompactOutput`, which expects `summary_md` and `memory_candidates` at the top level, so parsing fails.

## Code grounding

### Current compact path

`src/compactConversation.ts`:

- imports `buildCliInvocation`, but not `parseCliResult`.
- calls `runCli(...)` in `summarizePrompt`.
- returns `raw.trim()` from `summarizePrompt`.
- calls `parseCompactOutput(raw)` in `summarizeToOutput`.

That means compaction bypasses the normal CLI result parser.

### Normal execution path

`src/engine.ts` normal sync/async prompt execution calls:

```ts
parseCliResult({ bot: executionKind, stdout, logContent })
```

For Antigravity, `parseCliResult` delegates to `parseAntigravityResult`.

### Antigravity parser behavior

`src/cli.ts`:

- `wrapAntigravityPrompt` instructs Agy to output one JSON object with `reasoning` and `response`.
- `parseCliResult({ bot: "antigravity", ... })` calls `parseAntigravityResult`.
- `parseAntigravityResult` calls `tryParseAntigravityJson` and extracts the inner `response` field.

So compaction should use `parseCliResult` before `parseCompactOutput`.

## Related cascade-step error

The user also reported:

```text
error executing cascade step: CORTEX_STEP_TYPE_COMMAND_STATUS: command <id>/task-22 not Found
```

Current engine code already treats `error executing cascade step:` as a recoverable Antigravity execution error and retries with a fresh session.

This issue should verify that behavior remains covered, but the definite bug in this issue is the compaction parser bypass.

## Required fix

Update `src/compactConversation.ts` so compact output follows the same parsing boundary as normal prompt execution.

Conceptual change:

```ts
import { buildCliInvocation, parseCliResult } from "./cli.js";

const raw = await summarizePrompt(prompt);
const cliResult = parseCliResult({ bot: cliKind, stdout: raw });
const parsed = parseCompactOutput(cliResult.text);
```

Important details:

- Use `cliKind` as the `bot` value.
- Preserve current behavior for Claude, Codex, and Kimchi.
- Keep compaction non-destructive: if parsing fails, return `outcome: "failed"`, store no summary, and prune no turns.
- Do not change the compact JSON schema.
- Do not change memory candidate validation or storage.
- Do not prune turns unless final compact output is valid.

## Test plan

Add tests in `test/compactConversation.test.ts`.

### 1. Antigravity wrapped compact output succeeds

Arrange:

- `cliKind: "antigravity"`
- add one or more conversation turns
- mock `runCli` to return:

```json
{
  "reasoning": "summarised turns",
  "response": "{\"summary_md\":\"Current objective:\\n- continue task\",\"memory_candidates\":[]}"
}
```

Assert:

- result outcome is `compacted`,
- summary is stored,
- covered turns are pruned,
- stored summary equals the inner compact JSON summary.

### 2. Invalid Antigravity wrapped compact output remains non-destructive

Arrange:

- `cliKind: "antigravity"`
- mock `runCli` to return:

```json
{
  "reasoning": "bad output",
  "response": "not compact json"
}
```

Assert:

- result outcome is `failed`,
- no summary is stored,
- turns remain unpruned.

### 3. Existing direct compact JSON still works

Keep existing tests for Claude/direct JSON behavior passing.

### 4. Optional/focused cascade-step coverage

Review existing engine tests. If coverage is missing, add a focused test that an Antigravity error containing:

```text
error executing cascade step: CORTEX_STEP_TYPE_COMMAND_STATUS: command ... not Found
```

is treated as recoverable and triggers a fresh-session retry.

Do not broaden this PR into a full Antigravity reliability rewrite.

## Acceptance criteria

- `/compact` succeeds when Agy returns compact JSON inside its `response` field.
- Invalid Agy compact responses fail safely and non-destructively.
- Existing Claude/Codex/Kimchi compaction behavior remains intact.
- Existing normal Antigravity prompt execution parsing remains intact.
- Cascade-step recoverability is confirmed by existing or new tests.
- Full test and typecheck pass.

## Required checks

```bash
npm test
npm run typecheck
```

## Coding-agent prompt

```text
Implement issue #TBD in nickconstantinou/agent-bridge.

Problem:
/compact fails with Antigravity/Agy because compactConversation parses raw CLI stdout directly with parseCompactOutput. Agy stdout is wrapped as {"reasoning":"...","response":"..."}; the compact JSON is inside response. Normal prompt execution already uses parseCliResult to extract that response, but compaction bypasses it.

Tasks:
1. Read:
   - src/compactConversation.ts
   - src/compactSummary.ts
   - src/cli.ts
   - src/engine.ts
   - test/compactConversation.test.ts
2. Update src/compactConversation.ts to run raw stdout through parseCliResult({ bot: cliKind, stdout }) before parseCompactOutput.
3. Preserve non-destructive failure behavior: no summary stored and no turns pruned unless valid compact JSON is produced.
4. Add tests in test/compactConversation.test.ts for:
   - Antigravity wrapped output whose response contains valid compact JSON succeeds.
   - Antigravity wrapped output whose response is invalid compact JSON fails safely without pruning turns.
   - Existing direct JSON behavior still passes.
5. Review current Antigravity cascade-step retry coverage. If missing, add a focused test confirming `error executing cascade step: CORTEX_STEP_TYPE_COMMAND_STATUS: command ... not Found` is recoverable and triggers fresh-session retry.

Constraints:
- Do not change compact JSON schema.
- Do not alter memory candidate validation/storage.
- Do not broaden into a full Agy retry/reliability rewrite.
- Keep Claude, Codex, and Kimchi behavior compatible.

Run:
- npm test
- npm run typecheck

Open a PR that closes the linked issue and includes the exact failing scenario in the PR body.
```
