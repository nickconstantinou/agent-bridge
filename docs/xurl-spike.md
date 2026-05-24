# xURL Session Discovery Plan

Date: 2026-05-24
Status: planning artifact, not implemented
Owner: Agent Bridge

## Context

Agent Bridge is a Telegram-to-CLI orchestration layer for Codex, Antigravity, and Claude Code. It already owns the live execution path: Telegram polling, allowed-user checks, per-chat locks, CLI process lifecycle, session resume IDs, model fallback, SOUL.md prompt wrapping, streaming progress, cancellation, and Telegram rendering.

The current bridge state is intentionally small. The SQLite database stores Telegram-facing runtime state only:

- chat id
- current Codex, Antigravity, or Claude session id
- active execution lock
- Telegram polling offset
- model override settings

That is enough to route the next Telegram turn, but it is weak for history and inspection. If a user asks what sessions exist, what happened in a previous Codex thread, or wants to reference a prior session in another provider, Agent Bridge currently has no first-class discovery vocabulary.

`xurl` solves a related but different problem: a URI scheme and CLI for discovering, reading, querying, and writing agent conversations through addresses such as `agents://codex/<session-id>`. The spike tested whether Agent Bridge should adopt xURL directly, borrow its ideas, or ignore it.

## Spike Question

Would borrowing from `xurl` noticeably improve Agent Bridge compared with the current implementation?

## Spike Commands And Results

Baseline Agent Bridge checks:

```bash
npm test -- --run test/bridge.test.ts test/skills.test.ts
npm run typecheck
```

Results:

```text
67 passing
typecheck passing
```

xURL package availability:

```bash
npx -y @xuanwo/xurl --help
```

Result:

```text
works on this host without installing Rust
```

Codex session discovery:

```bash
npx -y @xuanwo/xurl 'agents://codex?limit=5'
```

Result:

```text
discovered local Codex threads in about 1.6s
```

Path-scoped discovery from the Agent Bridge repo:

```bash
npx -y @xuanwo/xurl 'agents://.?providers=codex,claude&limit=5'
```

Result:

```text
discovered local Codex and Claude threads scoped to the Agent Bridge repo in about 1.6s
```

Codex thread read/export:

```bash
npx -y @xuanwo/xurl 'agents://codex/019e4b84-03e5-78e2-b3af-34cbf9c3cb11'
```

Result:

```text
rendered a full local Codex thread with metadata and timeline in about 1.4s
```

Antigravity storage check:

```text
~/.gemini/antigravity/conversations/*.pb
~/.gemini/antigravity/brain/<uuid>/
~/.gemini/antigravity-cli/log/
```

Result:

```text
Antigravity is not the same as Gemini CLI storage. xURL's current Gemini provider should not be assumed to support Agy transcripts. Agy needs a separate adapter or parser spike.
```

## Key Findings

xURL produced a real improvement for read-only session intelligence:

- It discovered local Codex sessions without relying on Agent Bridge's SQLite mapping.
- It discovered Codex and Claude sessions scoped to the Agent Bridge repo.
- It rendered a readable local Codex thread with metadata and timeline.
- It introduced a useful stable reference shape: `agents://<provider>/<session-id>`.

xURL did not improve the live execution path:

- It does not know Agent Bridge's Telegram auth model.
- It does not own Telegram forum/topic routing.
- It does not own per-chat execution locks.
- It does not own streaming edits or final Telegram rendering.
- It does not know Agent Bridge's SOUL.md prompt wrapper.
- It does not know Agent Bridge's model fallback rules.
- It would add another runtime layer between Telegram and the CLIs if used for normal message execution.

## Decision

Use xURL as inspiration for read-only discovery and inspection. Do not route normal Telegram turns through xURL.

The implementation should be additive: Agent Bridge remains the execution engine; xURL-style URI support becomes a sidecar feature for session discovery, reading, and later handoff workflows.

## Architecture Rationale

### Decision 1: Keep Agent Bridge as execution owner

Rationale: Agent Bridge already controls the behavior that matters for Telegram reliability: process lifecycle, locks, cancellations, SOUL injection, output parsing, and rendering. Moving execution through xURL would duplicate or bypass those controls.

Alternatives considered:

- Route all turns through xURL write mode. Rejected because xURL does not know bridge prompt wrapping, Telegram-specific session isolation, locks, retries, or model fallback.
- Replace bridge session state with xURL. Rejected because SQLite stores live Telegram routing state, not historical transcript discovery.
- Ignore xURL entirely. Rejected because discovery and stable agent URIs are useful and validated by the spike.

### Decision 2: Add an internal `AgentUri` parser first

Rationale: URI parsing is small, deterministic, and useful even if xURL is unavailable. It keeps the bridge's command UX stable while the backing implementation can evolve.

Initial supported forms:

```text
agents://codex/<session-id>
agents://claude/<session-id>
agents://.?providers=codex,claude&limit=5
```

Deferred forms:

```text
agents://antigravity/<session-id>
agents://.?providers=codex,claude,antigravity&query=...
agents://codex/<session-id>?format=json
```

### Decision 3: Shell out to xURL only for read-only discovery in the first implementation

Rationale: The npm package worked on this host and returned useful output quickly. Shelling out avoids reverse-engineering Codex and Claude stores immediately.

Guardrails:

- Read-only commands only.
- Short timeout, recommended 5-10s.
- Clear user-facing error if xURL is missing or times out.
- No use of xURL write mode.
- Do not pass secrets or Telegram metadata to xURL.

### Decision 4: Treat Antigravity separately

Rationale: Agy state lives under Antigravity-specific paths and includes protobuf conversation files. It should not be lumped into xURL's Gemini provider without proof.

First Agy support should list what Agent Bridge already knows: the active Agy session ID from SQLite plus any recent Agy log/session IDs we can safely discover. Full transcript rendering needs a focused parser/export spike.

## Current Codebase Seams

Relevant existing files:

- `src/commands.ts`: command dispatch for `/start`, `/reset`, `/models`, `/skills`, and `/memory`.
- `src/db.ts`: SQLite state for sessions, locks, polling offsets, and settings.
- `src/cli.ts`: CLI invocation and provider-specific session handling.
- `src/bridge.ts`: model keyboard/text helpers and bridge orchestration helpers.
- `src/messageDelivery.ts`: streaming/final Telegram delivery.
- `test/bridge.test.ts`: broad bridge behavior tests.
- `test/skills.test.ts`: skill command/installer tests.
- `package.json`: currently no xURL dependency; only `better-sqlite3` and `dotenv` runtime deps.

Expected new files:

- `src/agentUri.ts`
- `src/sessionDiscovery.ts`
- `test/agentUri.test.ts`
- `test/sessionDiscovery.test.ts`

Expected changed files:

- `src/commands.ts`
- `src/types.ts`, only if command/result typing needs expansion
- `README.md`, after commands are implemented
- `.env.*.example`, only if introducing configurable xURL command path or timeout

Expected deleted files:

- None.

## Proposed User Experience

### `/sessions`

Returns recent local sessions for supported providers.

Example output:

```text
Recent sessions:

codex 019e4b84... agent-bridge 2026-05-24 10:21
claude 38265779... agent-bridge 2026-05-23 18:40

Open one:
/open agents://codex/019e4b84-03e5-78e2-b3af-34cbf9c3cb11
```

### `/sessions q=<term>`

Returns sessions matching a query term if xURL supports it reliably. If xURL's query semantics are insufficient, first implementation can restrict this to path/provider filtering and explicitly defer full-text search.

Example:

```text
/sessions q=agent-bridge
```

### `/sessions provider=codex`

Filters sessions to a provider.

Supported initial providers:

```text
codex
claude
```

Agy can be listed separately once the adapter is ready.

### `/open agents://codex/<session-id>`

Reads a session and returns a compact Telegram-safe summary.

Behavior:

- Use xURL to render the source session.
- Trim to Telegram-safe length.
- Prefer latest user request, latest assistant answer, cwd/repo, and timestamps.
- If output is too long, return the summary plus a note that full export is not yet implemented.

### Future `/handoff`

Not part of the first implementation.

Possible shape:

```text
/handoff agents://codex/<session-id> claude
```

First version should summarize or quote the source thread into a new provider prompt. It should not try to mutate or resume provider-native sessions across tools.

## Implementation Plan

### Phase 0: URI Foundations (Red -> Green -> Refactor)

Write failing tests in `test/agentUri.test.ts` for:

- Valid `agents://codex/<uuid>`.
- Valid `agents://claude/<uuid>`.
- Path-scoped discovery URI `agents://.?providers=codex,claude&limit=5`.
- Unsupported provider returns a typed error.
- Missing session ID returns a typed error for open/read mode.
- Invalid scheme is rejected.
- Limit is clamped to a safe maximum.

Implement `src/agentUri.ts`:

```ts
export type AgentProvider = "codex" | "claude" | "antigravity";

export type AgentUri =
  | { kind: "session"; provider: AgentProvider; sessionId: string }
  | { kind: "discovery"; providers: AgentProvider[]; limit: number; query?: string; cwd?: string };

export function parseAgentUri(value: string): AgentUri;
```

Gate:

```bash
npm test -- --run test/agentUri.test.ts
npm run typecheck
```

### Phase 1: Read-Only Discovery Adapter (Red -> Green -> Refactor)

Write failing tests in `test/sessionDiscovery.test.ts` for:

- Builds the correct xURL command for `/sessions`.
- Builds provider-filtered discovery.
- Enforces timeout.
- Converts xURL failure into a clean user-facing error.
- Does not call xURL write paths.
- Handles xURL missing from PATH or npm failure.

Implement `src/sessionDiscovery.ts`:

```ts
export interface SessionSummary {
  provider: "codex" | "claude" | "antigravity";
  sessionId: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
}

export interface SessionDiscoveryClient {
  list(options: { providers: string[]; limit: number; query?: string; cwd?: string }): Promise<SessionSummary[]>;
  read(uri: AgentUri): Promise<string>;
}
```

First implementation may shell out to:

```bash
npx -y @xuanwo/xurl 'agents://.?providers=codex,claude&limit=5'
```

Preferred hardening if this becomes production critical:

- Add `XURL_COMMAND` env var.
- Prefer an installed `xurl` binary over `npx` for latency and supply-chain stability.
- Pin package version if using `npx`.

Gate:

```bash
npm test -- --run test/sessionDiscovery.test.ts
npm run typecheck
```

### Phase 2: Telegram Commands (Red -> Green -> Refactor)

Write failing tests around `handleCommand` in `test/bridge.test.ts` or a new command-specific test file for:

- `/sessions` is recognized by `isBridgeCommand`.
- `/sessions provider=codex` returns a message result.
- `/sessions q=agent-bridge` passes the query to discovery.
- `/open agents://codex/<session-id>` is recognized.
- `/open` rejects unsupported providers clearly.
- Commands remain read-only and do not acquire execution locks or spawn Codex/Claude/Agy.

Change `src/commands.ts`:

- Add `/sessions` and `/open` to the command set.
- Route them to the discovery adapter.
- Keep existing `/reset`, `/models`, `/skills`, and `/memory` behavior unchanged.

Potential typing change:

- If async discovery is used directly in command handling, `handleCommand` may need to become async or the discovery commands may be handled one layer above it. Prefer the smallest change that keeps existing command tests readable.

Gate:

```bash
npm test -- --run test/bridge.test.ts test/sessionDiscovery.test.ts test/agentUri.test.ts
npm run typecheck
```

### Phase 3: `/open` Output Shaping (Red -> Green -> Refactor)

Write failing tests for Telegram-safe formatting:

- Long session text is trimmed to below Telegram limits.
- Code fences and Markdown are safe for current entity rendering.
- Output includes provider and short session ID.
- Empty session output produces a helpful message.
- xURL read failure is reported without stack traces.

Implement formatting helper, likely in `src/sessionDiscovery.ts` or `src/render.ts` if generic.

Example output:

```text
codex 019e4b84...
cwd: /home/openclaw/.openclaw/workspace/projects/agent-bridge

Latest user request:
Build a full implementation plan...

Latest assistant answer:
Spike complete. There is a noticeable improvement...
```

Gate:

```bash
npm test
npm run typecheck
```

### Phase 4: Antigravity Discovery Spike

Do not implement full Agy transcript reading until this spike is complete.

Spike questions:

- Can `~/.gemini/antigravity/conversations/*.pb` be decoded reliably with available tools?
- Is there a stable mapping from Agent Bridge Agy session ID to `.pb`, `brain/<uuid>`, or CLI log entries?
- Does Agy expose an export/read command that is safer than parsing protobuf files?
- Are timestamps/session IDs stable across restarts?

Spike commands to investigate:

```bash
find ~/.gemini/antigravity -maxdepth 3 -type f | head
file ~/.gemini/antigravity/conversations/*.pb
strings ~/.gemini/antigravity/conversations/*.pb | head
find ~/.gemini/antigravity-cli/log -type f -mtime -7 | head
```

Expected first implementation if transcript parsing is not stable:

- `/sessions provider=antigravity` lists active/recent IDs from Agent Bridge DB and logs.
- `/open agents://antigravity/<session-id>` returns a clear deferred message until parser support is proven.

Gate:

```bash
npm test
npm run typecheck
```

### Phase 5: Documentation And Rollout

Update `README.md` with:

- `/sessions` command.
- `/open agents://...` command.
- Supported providers.
- xURL dependency behavior.
- Clear statement that these commands are read-only.

If an env var is introduced, update:

- `.env.codex.example`
- `.env.antigravity.example`
- `.env.claude.example`

Potential env vars:

```text
XURL_COMMAND=xurl
XURL_TIMEOUT_MS=8000
SESSION_DISCOVERY_ENABLED=true
```

Recommended default for first rollout:

```text
SESSION_DISCOVERY_ENABLED=false
```

Then enable on the live host after smoke testing.

Gate:

```bash
npm test
npm run typecheck
sudo systemctl restart agent-bridge-codex agent-bridge-antigravity agent-bridge-claude
journalctl -u agent-bridge-codex -u agent-bridge-antigravity -u agent-bridge-claude --since '2 minutes ago' --no-pager
```

## Testing Strategy

Unit tests:

- `parseAgentUri` validation.
- URI query parsing.
- Provider validation.
- Limit clamping.
- xURL command construction.
- xURL failure mapping.
- Telegram output shaping.

Integration-style tests with mocked process runner:

- `/sessions` command returns compact message from mocked summaries.
- `/open` command returns compact session read from mocked xURL output.
- Timeout returns clear error.
- Missing xURL returns install/config guidance.

Manual smoke tests after implementation:

```bash
npm test
npm run typecheck
npx -y @xuanwo/xurl 'agents://.?providers=codex,claude&limit=5'
```

Telegram smoke tests:

```text
/sessions
/sessions provider=codex
/open agents://codex/<known-session-id>
```

## Observability

Add structured log tags for discovery operations:

```text
[sessions] list provider=codex,claude limit=5 duration_ms=...
[sessions] open provider=codex session=019e4b84... duration_ms=...
[sessions] xurl failed code=... stderr=...
[sessions] timeout after ...ms
```

Alert-worthy conditions:

- Repeated xURL timeout.
- xURL missing after feature enabled.
- Parser error for a URI that previously parsed.
- `/open` output exceeding Telegram limits after trimming.

Do not log full transcript contents by default. They may contain secrets or private project context.

## Environment And Secrets

No secrets are required.

Do not pass Telegram tokens, chat IDs, or bot config to xURL.

If using `npx`, consider pinning the version before enabling broadly:

```text
@xuanwo/xurl@<known-good-version>
```

If adding config, prefer:

```text
SESSION_DISCOVERY_ENABLED=false
XURL_COMMAND=npx -y @xuanwo/xurl
XURL_TIMEOUT_MS=8000
```

## Database Impact

No database migration is required for Phase 1-3.

Agent Bridge already stores current provider session IDs in `bridge_state`. Discovery should read native provider stores through xURL and should not write to the bridge DB.

Possible future table, only if caching is needed:

```sql
CREATE TABLE session_discovery_cache (
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT,
  title TEXT,
  updated_at TEXT,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (provider, session_id)
);
```

Do not add this table unless live xURL reads become too slow or unreliable.

## Frontend Impact

No frontend exists. Telegram command UX is the user interface.

## Rollback Plan

Because the feature is additive, rollback is simple:

1. Disable `SESSION_DISCOVERY_ENABLED` if added.
2. Remove `/sessions` and `/open` from the command set if necessary.
3. Restart the three bridge services.
4. Existing live execution remains unaffected because no core send/execute path changes are required.

## Success Criteria

Phase 1-3 are successful when:

- `/sessions` returns Codex and Claude sessions in under 10 seconds on the live host.
- `/open agents://codex/<session-id>` returns a useful compact summary.
- Missing xURL produces a clear message, not a stack trace.
- Unsupported Agy transcript reads are explicitly deferred rather than misleading.
- Existing commands still pass tests.
- `npm test` and `npm run typecheck` pass.
- No live Telegram execution behavior changes.

## Rollback Triggers

Rollback or disable the feature if:

- xURL regularly hangs beyond timeout.
- xURL output shape changes and breaks parsing.
- `/sessions` causes noticeable bridge latency for normal messages.
- Any command accidentally invokes xURL write mode.
- Transcript contents are logged unintentionally.

## Open Questions

- Should first implementation shell out to `npx -y @xuanwo/xurl`, or should xURL be installed/pinned as a local dependency?
- Should `/open` return a summary only, or should it save full output to a local file and return the path?
- Should session discovery be enabled for all three bots, or only the main Codex bot initially?
- What is the preferred Agy transcript source: protobuf decode, CLI export, or log-derived summary?
- Should `/handoff` be a command, or should users simply paste `agents://...` references into normal prompts?

## Recommended First PR

Implement only Phase 0 and Phase 1 plus a hidden/internal formatter. Do not expose Telegram commands until URI parsing and discovery failure handling are solid.

First visible PR should be Phase 0-2:

- `src/agentUri.ts`
- `src/sessionDiscovery.ts`
- `/sessions` command
- tests for parser, adapter, and command routing
- README update

Defer `/open` and Agy transcript support to separate PRs. That keeps the blast radius small and makes it easy to revert without touching the bridge execution path.
