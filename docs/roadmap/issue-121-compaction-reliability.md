# Issue #121 — Reliable Conversation Compaction Implementation Plan

Date: 2026-07-13
Status: Active
Issue: #121

## Delivery status

| Phase | Status | Delivery |
|---|---|---|
| Provider contract correctness and explicit outcomes | Complete | PR #125, squash commit `1ccb9dd` |
| Healthy fallback compaction | Complete | PR #126, squash commit `5801109` |
| Attempt telemetry and `/context` | Complete | PR #127, squash commit `0c684ff` |
| Structured-output recovery | Complete | PR #129, squash commit `5abf7aa` |
| Atomic persistence | Complete | PR #130, squash commit `793026e` |
| Execution lifecycle | Blocked on Issue #119 | Next after the shared run-supervisor boundary lands; do not create a second process registry |
| Acceptance and operations | Pending | Isolated provider smokes, lifecycle/failure coverage, rollback docs |
| Resumable chunk checkpoints | Optional | Implement only if telemetry demonstrates need |

The architecture and defect descriptions below preserve the original planning
baseline. This delivery table is authoritative for current implementation status.

## Purpose

Make manual `/compact`, automatic pre-seed compaction, and capacity-fallback handoff compaction reliable across Codex, Claude, Antigravity, and Kimchi without weakening the existing non-destructive safety guarantee.

The implementation must ensure that a failed compaction never:

- stores a new conversation summary;
- promotes memory candidates from an incomplete result;
- prunes raw conversation turns;
- blocks provider fallback;
- leaves an untracked child process consuming capacity;
- reports success or starts a success cooldown.

This plan is grounded in the current shared service and its callers:

- `src/compactConversation.ts`
- `src/compactSummary.ts`
- `src/cli.ts`
- `src/engine.ts`
- `src/interactiveBot.ts`
- `src/index-interactive.ts`
- `src/fallbackCompactCooldown.ts`
- `src/commands.ts`
- `src/db.ts`
- `test/compactConversation.test.ts`
- `test/interactiveBot.test.ts`

## Current architecture

### Shared compaction service

`compactConversation(chatKey, deps)` currently:

1. loads the previous compact summary;
2. loads every raw turn after that summary;
3. splits turns into character-bounded chunks;
4. invokes the active CLI once per chunk;
5. requires each response to parse as `{ summary_md, memory_candidates }`;
6. invokes the same CLI again to reduce chunk summaries when needed;
7. stores the final summary;
8. promotes final memory candidates;
9. prunes all covered raw turns.

Any invocation, parse, or timeout failure returns `outcome: "failed"` and leaves the database unchanged.

### Manual `/compact`

`BridgeEngine.handleMessages()` marks `compact_in_progress:<chatKey>`, calls the shared service, reports success or a generic failure, resets the active provider session only on success, then clears the in-progress flag.

### Pre-seed compaction

`BridgeEngine._maybePreseedCompact()` runs before a fresh `handoff_once` context injection when the uncompacted character count exceeds the configured threshold. It calls the shared service and ignores its returned outcome.

### Capacity-fallback compaction

`dispatchInteractiveWithFallback()` calls `compactBeforeSwitch(chatKey, activeCli)` after the active CLI reports capacity exhaustion and before switching to the next CLI. `index-interactive.ts` implements this by calling the shared service with the outgoing provider configuration. The returned outcome is ignored.

## Confirmed defects

### 1. Codex output-mode/parser mismatch

Normal Codex execution requests `outputFormat: "json"`, causing `buildCliInvocation()` to append `--json`. `parseCodexResult()` then extracts the final agent message from Codex JSON event lines.

Compaction does not set `outputFormat`, but still runs stdout through `parseCliResult()`. Plain Codex output does not contain the JSON events expected by `parseCodexResult()`, so the parser can return an empty string and `parseCompactOutput()` fails.

This is a provider contract defect, not a stochastic model-quality problem.

### 2. Capacity fallback invokes the exhausted provider

The fallback path calls compaction with `activeCli`, which is the provider that has just been classified as capacity exhausted. Large histories can require several additional calls to that provider. Failure is therefore expected.

### 3. Automatic callers ignore `failed` results

The shared service converts most errors into a normal result object. Catch blocks around the service do not see those failures. Pre-seed and fallback callers currently ignore `result.outcome`, producing silent failures.

### 4. Cooldown records attempts as successes

`recordFallbackCompactAttempt()` runs before compaction. A failed attempt suppresses subsequent compaction attempts for five minutes even though no summary was created.

### 5. The compact timeout does not cancel the process

The service wraps `runCli()` in a 60-second `Promise.race`. Rejecting the outer promise does not terminate the child process. `runCli()` can continue until its own longer timeout, consuming provider capacity and allowing overlapping retries after the in-progress marker is cleared.

### 6. Compaction bypasses normal execution configuration

The service currently does not consistently use:

- provider-specific output format;
- `buildExecutionOptions()`;
- normal working-directory resolution;
- tool-free execution;
- chat process registration for `/stop`;
- model fallback;
- provider fallback;
- structured-output repair.

### 7. Chunk processing is all-or-nothing

For N chunks, success requires N chunk calls plus one reduce call. Successful chunk summaries are not checkpointed. One later failure discards all completed work.

### 8. Diagnostics cannot measure reliability

The system does not persist the latest attempt trigger, selected provider/model, duration, chunk count, attempt count, error category, or outcome. `/context` only reports the latest successful summary timestamp and current in-progress state.

## Design principles

### One service, one execution contract

Manual, pre-seed, and fallback compaction must remain callers of one shared domain service. Reliability should be implemented below the caller boundary rather than duplicating provider logic in each caller.

### Database-owned conversation source

Compaction input must always come from Agent Bridge’s `conversation_turns` and previous summary, not from a provider-native session. This allows a healthy incoming provider to compact turns originally produced by an exhausted outgoing provider.

### Tool-free bounded transformation

Compaction is summarisation, not an engineering task. Every provider invocation must disable tools, plugins, hooks, shell access, MCP servers, browsing, and other agent capabilities where supported.

### Non-destructive commit boundary

No externally visible compaction state is committed until the final structured summary is valid. Raw turns remain authoritative until the summary insert and prune operation complete successfully.

### Explicit outcomes

Every caller must branch on `compacted`, `no_turns`, or `failed`. Failure must not be represented only through exceptions.

### Bounded recovery

Retries and fallback must be limited and auditable. The compaction subsystem must not enter open-ended provider loops.

## Target architecture

Introduce a dedicated execution layer beneath `compactConversation()`:

```text
manual / pre-seed / fallback caller
             |
             v
compactConversation(request)
             |
             v
CompactionExecutor.executeStructured(prompt, policy)
             |
             +-- provider adapter invocation
             +-- output extraction
             +-- compact JSON validation
             +-- one repair retry
             +-- eligible model/provider fallback
             +-- process cancellation
             +-- attempt telemetry
```

Suggested new modules:

- `src/compaction/types.ts`
- `src/compaction/executor.ts`
- `src/compaction/policy.ts`
- `src/compaction/telemetry.ts`
- `src/compaction/checkpoints.ts` in the resumable phase

The existing `src/compactConversation.ts` remains the domain coordinator and final database commit boundary.

## Data types

### Trigger

```ts
export type CompactionTrigger = "manual" | "preseed" | "capacity_fallback";
```

### Request context

```ts
export interface CompactConversationRequest {
  chatKey: string;
  trigger: CompactionTrigger;
  sourceCli: BotKind;
  preferredTargets: CompactionTarget[];
  compactProfile: CompactProfile;
  cancellationKey?: string;
}
```

`sourceCli` records which CLI owned the current conversation or initiated the handoff. It must not force execution through that provider.

### Target

```ts
export interface CompactionTarget {
  provider: BotKind;
  model: string | null;
}
```

### Attempt result

```ts
export type CompactionErrorKind =
  | "auth"
  | "capacity"
  | "timeout"
  | "cancelled"
  | "provider_unavailable"
  | "model_unavailable"
  | "transient"
  | "invalid_output"
  | "unknown";

export interface CompactionAttemptResult {
  status: "succeeded" | "failed";
  provider: BotKind;
  model: string | null;
  ordinal: number;
  durationMs: number;
  repair: boolean;
  errorKind?: CompactionErrorKind;
  errorMessage?: string;
  output?: CompactOutput;
}
```

### Final service result

Extend `CompactConversationResult` with non-sensitive diagnostics:

```ts
export interface CompactConversationResult {
  outcome: "compacted" | "no_turns" | "failed";
  trigger: CompactionTrigger;
  provider?: BotKind;
  model?: string | null;
  durationMs?: number;
  chunkCount?: number;
  callCount?: number;
  errorKind?: CompactionErrorKind;
  // existing summary/range/memory fields remain
}
```

Do not expose raw prompts, model reasoning, complete stdout, conversation text, or summary contents through telemetry.

## Configuration

Add explicit configuration with safe defaults:

```dotenv
# Ordered provider/model targets used when no caller-specific healthy target is supplied.
BRIDGE_COMPACTION_CHAIN=claude:default,codex:default,antigravity:default

# Wall-clock timeout for one provider attempt. Must terminate the process tree.
BRIDGE_COMPACTION_TIMEOUT_MS=90000

# One repair attempt after a syntactically or structurally invalid response.
BRIDGE_COMPACTION_REPAIR_ATTEMPTS=1

# Maximum provider/model attempts for one chunk or reduce operation.
BRIDGE_COMPACTION_MAX_ATTEMPTS=3

# Existing chunk and parallelism variables remain, but start conservatively.
BRIDGE_COMPACT_PARALLELISM=1
```

Rules:

- `default` resolves through the target provider’s configured model preference.
- Invalid targets are dropped through the existing provider selection/config validation patterns.
- Capacity fallback must exclude the exhausted provider from the first target and preferably from all targets for the current logical operation.
- Manual compaction may prefer the active provider when it is healthy.
- Pre-seed compaction may prefer the target provider for the fresh session.
- Defaults must preserve existing deployments when no new variables are configured.

## Delivery plan

The work should be delivered as small implementation PRs. The planning PR must not be merged together with runtime changes.

### PR 1 — Provider contract correctness and outcome handling — complete in #125

#### Scope

Fix deterministic correctness defects without introducing the full new architecture.

#### Changes

`src/compactConversation.ts`

- Set provider-appropriate output configuration in `buildCliInvocation()`.
- For Codex and Claude, request JSON CLI output where their parser expects it.
- Continue using Agy’s outer wrapper parser.
- Pass `toolMode: "none"` for every supported provider.
- Pass provider-specific execution options rather than `{}`.
- Add `trigger` to dependencies/request and result metadata.

`src/engine.ts`

- Manual `/compact` explicitly passes `trigger: "manual"`.
- `_maybePreseedCompact()` explicitly passes `trigger: "preseed"`.
- Inspect the returned outcome.
- Log a structured warning on `failed` rather than relying on thrown errors.
- Keep pre-seed failure non-blocking.

`src/index-interactive.ts` and `src/interactiveBot.ts`

- Change `compactBeforeSwitch` to return `CompactConversationResult`.
- Branch on the outcome.
- Keep fallback non-blocking.
- Do not record a success cooldown before the call.

`src/fallbackCompactCooldown.ts`

- Split attempt and success timestamps, or record only successful completion.
- Recommended keys:
  - `fallback_compact_last_attempt_at:<chatKey>`
  - `fallback_compact_last_success_at:<chatKey>`
- Cooldown eligibility should be based on success, with a separate short anti-storm attempt guard if needed.

#### Tests first

Add red tests proving:

1. Codex invocation includes `--json` and valid compact JSON inside a Codex final-message event succeeds.
2. Claude JSON result extraction remains compatible.
3. Agy wrapped compact output remains compatible.
4. Tool-free flags are present for Codex, Claude, and Agy.
5. Pre-seed logs or records a failed outcome while allowing the user turn to continue.
6. Fallback continues after a failed returned outcome.
7. Failed fallback compaction does not set the success cooldown.
8. Successful fallback compaction sets the success cooldown.
9. Non-destructive failure assertions remain unchanged.

#### Acceptance

- Real Codex invocation/parser contract is internally consistent.
- All callers explicitly handle every outcome.
- Automatic failures are no longer silent.
- No failed attempt is counted as a successful cooldown.

### PR 2 — Persistent attempt telemetry and `/context` diagnostics

#### Schema

Add a `compaction_attempts` table:

```sql
CREATE TABLE compaction_attempts (
  id                    TEXT PRIMARY KEY,
  chat_key              TEXT NOT NULL,
  trigger               TEXT NOT NULL,
  source_cli            TEXT NOT NULL,
  selected_provider     TEXT,
  selected_model        TEXT,
  outcome               TEXT NOT NULL,
  error_kind            TEXT,
  chunk_count           INTEGER NOT NULL DEFAULT 0,
  call_count            INTEGER NOT NULL DEFAULT 0,
  covered_start_turn_id INTEGER,
  covered_end_turn_id   INTEGER,
  duration_ms           INTEGER NOT NULL DEFAULT 0,
  started_at            TEXT NOT NULL,
  ended_at              TEXT NOT NULL
);

CREATE INDEX idx_compaction_attempts_chat
ON compaction_attempts(chat_key, started_at DESC);
```

Do not persist prompts, raw provider output, conversation text, memory candidates, or summary text.

#### Repository layer

Prefer extracting a small `CompactionRepository` rather than expanding `db.ts` indefinitely.

Required methods:

- `startCompactionAttempt()`
- `finishCompactionAttempt()`
- `getLatestCompactionAttempt(chatKey)`
- `getCompactionStats(chatKey?)`

#### `/context`

Add:

```text
Latest compact attempt: 2026-07-13T...
Trigger: capacity_fallback
Outcome: failed (capacity)
Provider/model: codex/gpt-...
Chunks/calls: 4/1
Duration: 60123 ms
```

Keep the existing latest successful compact timestamp separately.

#### Logging

Emit one structured completion line per logical attempt:

```text
[compact] completed attemptId=... chatKey=... trigger=... outcome=... provider=... model=... chunks=... calls=... durationMs=... errorKind=...
```

No prompt or summary content.

#### Tests first

- migration on fresh and existing databases;
- success and failure persistence;
- no content leakage in persisted fields;
- `/context` rendering for no attempt, success, and failure;
- automatic trigger metadata.

### PR 3 — Abortable execution and process ownership

This work must integrate with the shared run supervisor from Issue #119. It
must not add a compaction-only process registry, cancellation map, or competing
process-lifecycle abstraction. Start this phase only when #119 exposes the
required supervisor boundary on `main`.

#### Problem

`Promise.race` changes the caller’s result but does not cancel the process.

#### Preferred design

Move the timeout boundary into the process execution layer. Avoid a second timer wrapped around `runCli()`.

Extend execution options only if necessary:

```ts
interface CliOptions {
  timeoutMs?: number;
  chatId?: string | number;
  processPurpose?: "prompt" | "compaction" | "advisor";
}
```

Use:

- `timeoutMs: compactionTimeoutMs()`;
- `chatId: chatKey` or a purpose-qualified registration key;
- existing process-group termination;
- the existing grace period and `SIGKILL` escalation.

#### Process registry

The current registry permits one process per chat. Chunk parallelism can create multiple processes. Do not overwrite a single child registration.

Refactor to one of:

```ts
Map<chatKey, Set<ChildProcess>>
```

or purpose-qualified keys with a chat-level cancellation index.

`/stop` must terminate all active prompt and compaction processes for the chat and clear queued work consistently.

#### Remove

- the `Promise.race` timer from `compactConversation.ts`;
- any timer that can reject without owning process cancellation.

#### Tests first

- compact timeout sends termination to the child process group;
- the result is categorized as `timeout`;
- no child remains registered after close;
- `/stop` cancels active compaction;
- multiple chunk children are all cancelled;
- late child close cannot deregister a newer child;
- no summary or prune occurs after timeout.

### PR 4 — Healthy target selection for fallback compaction

#### Decision

Capacity-fallback compaction must run through a healthy target, not the exhausted outgoing provider.

The recommended order is:

1. incoming fallback provider/model;
2. remaining configured compaction chain excluding the exhausted provider;
3. fail non-destructively and continue fallback.

The input remains the shared Agent Bridge conversation backlog, so the incoming provider does not need the outgoing provider’s native session.

#### API change

Replace:

```ts
compactBeforeSwitch(chatKey, fromCli)
```

with:

```ts
compactBeforeSwitch({
  chatKey,
  fromCli,
  toCli,
  exhaustedProviders,
})
```

The fallback dispatcher already resolves `next` before the call and can pass it explicitly.

#### Ordering correction

The target provider’s session must not be used for compaction. Compaction invocations remain fresh, tool-free, and stateless. The subsequent user turn starts a separate fresh native session seeded by Agent Bridge context.

#### Failure behaviour

- Failed compaction does not block the provider switch.
- Handoff is still marked.
- Raw turns remain available and are injected within existing context budgets.
- Telemetry records the failed capacity-fallback compact.

#### Tests first

- Codex exhausted, Claude next: compaction invokes Claude, never Codex.
- Claude compaction failure still switches to Claude for the user turn.
- Multiple exhausted providers are excluded.
- No healthy target produces a non-destructive failed outcome.
- Successful incoming-provider compaction seeds the next turn with the new summary.

### PR 5 — Structured-output repair and bounded target fallback

#### Extraction pipeline

Keep provider output extraction and compact schema parsing separate:

```text
raw stdout
→ parseCliResult(provider)
→ compact response text
→ parseCompactOutput(text)
```

Enhance `parseCompactOutput()` conservatively:

1. exact JSON;
2. whole-response JSON fence;
3. one unambiguous outer JSON object extraction only when no competing object exists.

Do not accept arbitrary prose summaries as successful compaction.

#### Repair attempt

When provider extraction succeeded but compact schema parsing failed, make one tool-free repair call with:

- the invalid response;
- the schema;
- an instruction to preserve content and output exactly one corrected JSON object;
- no raw conversation repeated unless required.

The repair attempt counts against the configured maximum.

#### Fallback eligibility

Eligible for the next target:

- auth failure;
- capacity/rate limit;
- timeout;
- provider/model unavailable;
- transient execution failure;
- invalid structured output after repair.

Not eligible:

- explicit user cancellation;
- configuration validation failure that invalidates the whole chain;
- database commit failure;
- invariant violation after a valid final output.

#### Tests first

- fenced JSON succeeds without repair;
- prose around one JSON object can be extracted safely;
- ambiguous multiple JSON objects fail;
- malformed JSON succeeds after one repair;
- repair failure advances to the next target;
- cancellation does not fall back;
- attempt and call budgets are enforced;
- raw invalid output is not persisted.

### PR 6 — Atomic final commit

The current sequence inserts a summary, promotes memories, then prunes turns. Wrap the final state transition in one database transaction where practical.

Recommended semantics:

1. validate final output completely;
2. validate all memory candidates independently;
3. begin transaction;
4. insert the summary;
5. insert accepted memory candidates;
6. prune covered turns;
7. commit;
8. record successful attempt completion.

Rejected memory candidates are counted but do not fail compaction.

A database exception rolls back all summary, memory, and prune changes and records a failed logical attempt outside the failed transaction.

#### Tests first

Inject failures at:

- summary insert;
- memory insertion;
- prune;
- commit.

Assert that no partial state remains.

### PR 7 — Resumable chunk checkpoints (optional)

This phase should follow the P0/P1 reliability fixes rather than block them,
and should be implemented only when attempt telemetry proves checkpoint reuse
is operationally necessary.

#### Storage

Add checkpoint tables or a JSON checkpoint record keyed by:

- logical compaction attempt ID;
- chat key;
- covered start/end turn IDs;
- chunk ordinal;
- deterministic content hash;
- summary text;
- provider/model;
- status.

Checkpoint content contains compact chunk summaries, not raw turns or provider reasoning.

#### Idempotency

A retry may reuse a successful checkpoint only when:

- the turn range matches;
- the deterministic input hash matches;
- the compact profile and prompt schema version match.

#### Reduce checkpoint

The final reduce operation should have its own deterministic input hash over:

- previous summary identity/hash;
- ordered chunk summary hashes;
- compact profile;
- schema version.

#### Cleanup

- delete checkpoints after a successful final commit;
- retain failed-attempt checkpoints for a bounded period or attempt count;
- clean stale checkpoints through an explicit maintenance path.

#### Tests first

- one failed chunk retries without rerunning successful chunks;
- changed input invalidates stale checkpoints;
- final reduce retry reuses chunk checkpoints;
- successful commit removes checkpoints;
- no raw turns are pruned before final success.

### PR 8 — Provider contract smoke tests and operational runbook

#### Unit contract tests

For every provider, assert the exact invocation/output boundary:

- Codex flags and JSON event parser;
- Claude flags and result parser;
- Agy wrapper and inner response parser;
- Kimchi plain-text limitations or explicit support decision.

#### Opt-in live smoke tests

Create a non-CI-default script, for example:

```bash
npm run smoke:compact -- --provider codex
npm run smoke:compact -- --provider claude
npm run smoke:compact -- --provider antigravity
```

The script should:

1. create an isolated temporary database;
2. insert synthetic non-secret turns;
3. run one small compaction;
4. verify summary creation and turn pruning;
5. print provider/model, duration, and outcome;
6. clean up the temporary database;
7. never touch production chat data.

#### Runbook

Document:

- configuration;
- how to inspect `/context`;
- how to query aggregate attempt stats;
- how to diagnose timeout, capacity, and invalid-output failures;
- rollback switches;
- how to disable automatic pre-seed or fallback compaction independently.

## Test strategy

### Unit tests

Primary files:

- `test/compactConversation.test.ts`
- new `test/compactionExecutor.test.ts`
- new `test/compactionTelemetry.test.ts`
- `test/interactiveBot.test.ts`
- `test/engine.test.ts`
- `test/cli.test.ts`
- `test/commands.test.ts`
- database migration/repository tests

### Integration tests

Use the real invocation builder and parser together with a fake process response. Do not mock `compactConversation()` at the boundary being tested.

Required provider fixtures:

- Codex JSON event stream containing `thread.started` and final `agent_message`;
- Claude JSON result object;
- Agy `{ reasoning, response }` wrapper;
- malformed and fenced compact JSON;
- capacity, timeout, cancellation, and unavailable-model errors.

### Property/invariant tests

For every failed path assert:

- latest summary is unchanged;
- raw turn count and contents are unchanged;
- no new memory is stored;
- no successful cooldown is recorded;
- no active child remains registered after completion;
- fallback or user turn continues when required.

### Concurrency tests

- two manual `/compact` requests for one chat result in one execution;
- pre-seed skips while manual compact is active;
- fallback skips or reuses an in-progress logical compact rather than starting another;
- separate chats can compact concurrently within global limits;
- `/stop` only cancels the intended chat.

## Rollout

### Defaults during rollout

- keep pre-seed mode opt-in as currently designed;
- keep fallback compaction non-blocking;
- set parallelism to one until process ownership and telemetry prove stability;
- enable one repair attempt;
- restrict maximum attempts per operation;
- do not enable resumable checkpoint reuse until its idempotency tests pass.

### Deployment sequence

For each runtime PR:

1. run focused compaction tests;
2. run the full test suite;
3. run typecheck and architecture lint;
4. deploy behind existing automatic-compaction switches;
5. run provider smoke tests on the target host;
6. inspect telemetry for success/failure categories;
7. enable pre-seed/fallback automation only after manual compact succeeds for every authenticated provider intended for use.

### Rollback

Provide or preserve independent controls:

- `BRIDGE_PRESEED_COMPACT_MODE=off`
- a fallback-compaction enable switch if one does not already exist;
- a compaction chain that can be reduced to one known-good provider;
- repair attempts set to zero;
- resumable checkpoints disabled.

Manual `/compact` should remain available when automatic modes are disabled, provided at least one compaction target is healthy.

## Security and privacy

- Tool-free execution is mandatory.
- Child environments must retain existing token and Telegram secret scrubbing.
- Telemetry must not store prompts, conversation text, provider reasoning, raw stdout, summary bodies, memory candidate text, tokens, or credentials.
- Error messages persisted to the database must be categorized and bounded; avoid raw provider dumps.
- Compaction chain configuration must not expose credentials through `/context`.
- Temporary files and logs must be removed on success, failure, timeout, and cancellation.

## Performance expectations

Initial targets after PRs 1–5:

- small one-call manual compaction: at least 95% success when the selected provider is healthy;
- capacity-fallback compaction: never call the exhausted provider;
- no active compaction child after terminal outcome plus kill grace;
- one malformed response may consume one repair call, never an unbounded loop;
- `/context` diagnosis available immediately after every attempt.

Do not claim these targets are met until telemetry has collected enough real attempts.

## Definition of done

Issue #121 is complete when:

- manual compaction succeeds against the real Codex, Claude, and Agy contracts used in production;
- automatic callers inspect and persist outcomes;
- capacity-fallback compaction uses a healthy provider target;
- timeout cancellation terminates the process tree;
- `/stop` cancels active compaction for the chat;
- tool-free mode is enforced;
- structured-output repair and bounded fallback are implemented;
- final summary/memory/prune changes are atomic and non-destructive on error;
- `/context` exposes the latest attempt and outcome;
- aggregate telemetry can quantify reliability without retaining conversation content;
- provider contract tests and opt-in live smoke tests pass;
- documentation and rollback controls are current.

## Coding-agent handoff

Implement Issue #121 as small, ordered PRs; do not combine phases. PR 1 is
complete in #125. Continue with healthy target selection for capacity fallback.
Execution-lifecycle work depends on Issue #119 and must reuse its shared run
supervisor rather than introduce a second process registry.

For every PR:

1. Read the current versions of all affected files and this plan before editing.
2. Write failing tests first for each acceptance criterion.
3. Preserve non-destructive failure semantics.
4. Do not log or persist prompts, raw conversation contents, summary bodies, memory text, provider reasoning, or secrets.
5. Keep automatic compaction non-blocking.
6. Run focused tests, full tests, typecheck, and architecture lint.
7. Include exact provider invocation/parser fixtures in the PR description.
8. Stop after the scoped PR is mergeable; do not silently begin the next phase.
