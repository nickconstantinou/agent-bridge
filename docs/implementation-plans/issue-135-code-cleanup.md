# Issue #135 implementation plan: staged runtime cleanup

Status: implementation-ready planning contract  
Issue: #135 — Reduce duplicate runtime ownership and retire verified legacy code  
Branch: `plan/issue-135-code-cleanup`

## 1. Mission for the coding agent

Reduce duplicated ownership and safely remove verified dead or obsolete code without weakening Agent Bridge's execution, cancellation, recovery, compatibility, or deployment guarantees.

This is not a rewrite and not a line-count exercise. The objective is to make each runtime concern have one authoritative owner while preserving current public contracts until callers and deployments have migrated.

The implementation must proceed as a sequence of small PRs. Do not implement every phase in one branch. This planning PR is documentation-only and does not close Issue #135.

GitHub issue #135 remains the source of truth for scope, acceptance, and progress.

## 2. Mandatory working method

Before changing code:

1. Read `AGENTS.md`, `CLAUDE.md`, and all repository instructions they reference.
2. Read Issue #135 and this plan in full.
3. Read Issue #133 before touching `src/cli.ts`, process registration, termination, or execution locking.
4. Read Issue #88 before extracting Claude settings.
5. Inspect the current code and tests listed in section 5.
6. Confirm the exact main head and create an isolated worktree/branch using the repository's `git-sandbox` practice.
7. Record the baseline for the full suite, typecheck, Architecture Lint, and `git diff --check`.
8. Run an audit-only dead-code/dependency scan before changing the dependency graph.

For every production-behaviour phase:

1. add focused failing tests first;
2. run them and record the expected red failures;
3. commit the red tests separately;
4. implement the narrowest change that makes them pass;
5. commit the green implementation separately;
6. run focused and directly affected suites;
7. run the full verification matrix before marking the PR ready.

Do not weaken an existing test merely because ownership moves. Replace structural assertions only with equivalent or stronger behavioural assertions.

Documentation-only or dependency-classification changes do not require artificial behavioural red tests, but must have a static contract test when regression is realistically possible.

## 3. Locked design decisions

These decisions are not left for the coding agent to reinterpret.

### 3.1 Cleanup is staged, not atomic

Deliver separate PRs in this order:

1. safe hygiene and cleanup detection;
2. unified CLI process supervision;
3. provider-boundary extraction;
4. database schema and repository boundaries;
5. compatibility retirement after evidence.

Each PR must be independently reviewable and revertible.

### 3.2 Issue #133 takes priority over supervisor cleanup

Issue #133 is a production risk gate for shared Git worktrees and is expected to modify or depend on the existing CLI supervisor.

Phase 1 may proceed before Issue #133.

Phase 2 must not begin until one of the following is true:

- Issue #133 is merged and Phase 2 rebases onto it; or
- an explicit combined implementation plan is approved that proves there will still be one process registry and one supervised child lifecycle.

Do not create a second registry, lock waiter registry, or parallel cancellation mechanism.

### 3.3 Public execution contracts remain stable during consolidation

Retain these exports initially:

- `runCli()` returning `Promise<string>`;
- `runCliAsync()` returning `Promise<{ text: string }>`;
- process abort and shutdown helpers used by current callers;
- existing `CliOptions` callback and event contracts.

The internal lifecycle may be replaced by one core runner, but callers must not be forced into a repository-wide migration in the same PR.

### 3.4 One authoritative child-process lifecycle

The shared internal runner must exclusively own:

- argument normalisation before spawn;
- child environment construction and advisor scrubbing;
- `spawn()` and stdin handling;
- detached process-group setup;
- active execution registration and identity-checked deregistration;
- hard timeout;
- idle timeout;
- Antigravity planner-stall detection;
- stdout and stderr collection;
- optional progress delivery;
- run event emission;
- graceful termination and escalation;
- close/error settlement;
- teardown waiting.

Adapters may shape return values, but must not reimplement lifecycle behaviour.

### 3.5 Cancellation and timeout semantics must not drift

Preserve the semantics current main and active lifecycle work require:

- `/stop`, `/cancel`, `/reset`, timeout, and service shutdown terminate the full child process tree;
- cancellation waits for confirmed child exit before releasing execution ownership where required;
- a late close from an older child cannot deregister a newer child;
- advisor child environment secrets remain scrubbed;
- no cancelled or displaced attempt performs success-side effects;
- process teardown tests report no leaked handles or children.

Where current synchronous and asynchronous runners differ unintentionally, add a parity test and select the safer behaviour. Do not silently choose based on which implementation is easier to preserve.

### 3.6 Provider modules own provider policy; the supervisor owns processes

Provider modules may own:

- invocation flags and stdin construction;
- output parsing;
- provider-specific mutable state preparation;
- provider-specific error extraction;
- provider capability checks.

The process supervisor must remain provider-agnostic except for an explicitly injected stall detector or lifecycle hook. Do not move provider policy into a new generic runner under different names.

### 3.7 Align Claude extraction with Issue #88

Do not create two Claude settings abstractions.

The target should be one module, expected to resemble:

```text
src/claudeSettings.ts
  resolveClaudeSettings(env)
  buildClaudeSettingsJson(env)
  buildClaudeSettingsArg(env)
  describeClaudeSettings(env)
```

If Issue #88 lands first, consume it. If Phase 3 lands first, update Issue #88 and ensure its acceptance criteria are included rather than duplicated.

### 3.8 `BridgeDb` remains a façade during database extraction

Move schema and SQL ownership incrementally without forcing every caller to import repositories directly.

Initially retain `BridgeDb` methods and delegate to repositories. The first database-boundary PR must not combine schema versioning with broad caller rewrites.

### 3.9 Historical migrations are production compatibility code until proven otherwise

Do not remove an old migration because it appears to have run on the developer database.

A migration or repair may be removed only when:

- the repository defines a minimum supported schema version;
- all platform-managed appliances are inventoried above that version;
- upgrade from the oldest supported version is tested;
- rollback or restore expectations are documented;
- the PR includes operator evidence and a separate approval for the retirement.

### 3.10 Compatibility aliases require evidence and a deprecation window

The following are not Phase 1 deletion targets:

- `WORKER_CLI_CHAIN` fallback in interactive routing;
- `TELEGRAM_ALLOWED_USER_ID`;
- `GEMINI_*` aliases;
- `gemini_session_id` migration/backfill support;
- `HEALTH_CLI_*` aliases;
- Antigravity `***` delimiter parsing;
- Antigravity `🧠 Memory Loaded:` parsing.

Retirement requires metadata-only diagnostics or bounded startup warnings, generated-config migration, deployment inventory, a documented deprecation window, and zero-use evidence.

### 3.11 The broad `bridge.ts` export surface is compatibility debt, not an immediate deletion target

New code should import from the owning module. Existing imports may migrate gradually.

Do not remove a re-export until repository search and typecheck prove no callers remain. Prefer a static boundary test that prevents new imports from the barrel for responsibilities with established owners.

## 4. Expected PR sequence

### PR 1 — safe hygiene and cleanup checks

Suggested title:

```text
chore: remove safe duplication and add cleanup checks
```

Scope:

- remove or archive lowercase `agents.md`, leaving `AGENTS.md` canonical;
- remove the duplicate `parseModelPreference()` implementation from `src/bridge.ts` and import/re-export the canonical `src/config.ts` helper only where compatibility is required;
- prove there is no production runtime import of the local mock Agy package;
- move `@google/agy-cli: file:test/mocks/mock-agy-cli` to `devDependencies`, or remove it entirely if no test resolution requires the package entry;
- add a repeatable dead-code and dependency audit, preferably `knip`;
- add a minimal reviewed configuration/ignore list rather than suppressing whole directories;
- add an audit command for TypeScript unused locals/parameters without immediately enabling it in the default typecheck if the initial baseline is large;
- document all remaining findings in the PR or Issue #135 checklist.

Must not touch:

- process spawning;
- execution locks;
- cancellation;
- provider parsing;
- database migrations;
- deployed compatibility aliases.

Suggested static tests:

- only one canonical agent instruction file exists at repository root, or the lowercase file is an explicit short redirect with no duplicated operating rules;
- `src/bridge.ts` does not define `parseModelPreference` locally;
- no production package dependency resolves from `test/`;
- cleanup scan command exists and succeeds with the reviewed baseline.

### PR 2 — unified CLI process supervision

Suggested title:

```text
refactor: unify CLI process supervision
```

Dependency:

- blocked on Issue #133 merge or explicit combined-plan approval.

Target structure:

```text
src/cliSupervisor.ts
  runSupervisedProcess(request)
  terminateExecution(...)
  shutdownSupervisedProcesses(...)
  lifecycle registry and fencing integration

src/cli.ts
  runCli(...) adapter
  runCliAsync(...) adapter
  compatibility exports while callers migrate
```

The exact file names may change, but ownership must be explicit.

#### Red tests first

Add focused tests that fail on current duplicated implementations or would detect drift during consolidation:

1. sync and async paths use identical child environment scrubbing;
2. sync and async paths preserve all disabled Codex tool flags after normalisation;
3. sync and async timeout paths terminate the full process group and wait for close;
4. idle timeout behaviour is equivalent;
5. Antigravity planner-stall behaviour is equivalent;
6. user cancellation is classified consistently and does not produce success events;
7. close/error settlement is single-shot under timeout races;
8. an older child closing cannot deregister a newer child;
9. shutdown waits for every tracked child and leaves no process/handle leaks;
10. the Issue #133 worktree lock holder or waiter remains within the same supervised cancellation tree.

#### Green implementation

- introduce one internal request/outcome model;
- move common spawn and lifecycle code once;
- implement `runCli()` and `runCliAsync()` through it;
- preserve progress callbacks as optional projections;
- preserve exact public return contracts at the adapters;
- retain existing event types and logging redaction;
- remove only duplicated private helper branches made unreachable by the shared core.

#### Verification

Run at minimum:

- `test/cli.test.ts`;
- `test/executionLaneCorrectness.test.ts`;
- `test/runCommandAsync.auth-fallback.test.ts`;
- advisor fallback smoke tests;
- message delivery and engine cancellation tests;
- Issue #133 focused concurrency/process-tree tests;
- full parallel suite twice;
- full serial suite with leak diagnostics;
- typecheck and Architecture Lint.

### PR 3 — provider runtime boundaries

Suggested title:

```text
refactor: extract provider invocation and parsing boundaries
```

Deliver as more than one PR if review size grows.

Suggested boundaries:

```text
src/providers/codexRuntime.ts
src/providers/claudeRuntime.ts
src/providers/antigravityRuntime.ts
src/providers/kimchiRuntime.ts
src/claudeSettings.ts
```

Each provider runtime should expose only the minimum required capabilities, for example:

```text
buildInvocation(request)
parseResult(output)
prepareRuntimeState(context)        # only where required
resolveSessionAfterRun(context)     # only where required
classifyProviderOutputFailure(...)  # if not already shared
```

Do not force every provider into methods it does not need.

#### Red tests first

- invocation snapshots for every provider and mode;
- tool-free advisor and compaction flags;
- attachment paths and stdin contracts;
- trusted/safe execution flags;
- session resume/fresh-session rules;
- Antigravity model/state file handling;
- Claude stream-json and settings handling;
- malformed and legacy provider output parsing;
- Kimchi session resolution and tool/thought stripping;
- provider-specific failures remain fallback-classified as before.

#### Green implementation

- move code without behavioural changes;
- keep compatibility exports temporarily where required;
- migrate internal imports to provider-owned modules;
- move `validateBridgeConfig()` into `config.ts` and replace `any` with `BridgeConfig` or a narrower input type;
- narrow `src/bridge.ts` re-exports only after callers migrate;
- add an architecture test preventing new provider policy from accumulating in the supervisor.

### PR 4 — database schema and repository boundaries

Suggested title:

```text
refactor: version database migrations and repository ownership
```

This phase should be split if schema versioning and repository extraction are independently reviewable.

Target structure:

```text
src/db/schema.ts
src/db/migrations/001-....ts
src/db/migrations/002-....ts
src/repositories/advisorRepository.ts
src/repositories/conversationRepository.ts
src/db.ts                         # openDb + compatibility façade
```

#### Locked migration requirements

- use `PRAGMA user_version` or one explicit migration ledger;
- migrations are ordered, idempotent at the runner level, and transactional where SQLite permits;
- fresh database creation and upgrade creation converge on the same schema;
- no migration catches and ignores an unexpected failure without a bounded warning or startup failure policy;
- foreign-key disable/enable sequences are restored in `finally` blocks and verified;
- current execution-lane migration/quarantine behaviour remains unchanged unless separately specified.

#### Red tests first

- fresh database reaches current schema version;
- upgrades from representative historical schemas preserve data;
- interrupted migration rolls back or is safely resumable;
- foreign keys are re-enabled after failure;
- advisor calls delegate through `AdvisorRepository` with unchanged budget/audit semantics;
- conversation turns, summaries, pending messages, and compaction metadata delegate through `ConversationRepository` without weakening lock fencing;
- `BridgeDb` public methods retain existing results and transaction semantics.

#### Green implementation

- extract schema creation and upgrades;
- introduce repositories;
- delegate from `BridgeDb`;
- do not rewrite all callers;
- record the current schema version and minimum supported version separately;
- retain all historical migrations initially.

### PR 5 — compatibility retirement

Suggested title pattern:

```text
chore: retire verified <alias-or-fallback>
```

Do not group unrelated aliases into one PR merely for convenience.

For each candidate:

1. add or verify metadata-only usage detection;
2. update installer and platform-generated defaults;
3. deploy the warning/inventory phase separately;
4. collect zero-use evidence over the agreed window;
5. verify database schema inventories where applicable;
6. add failing tests asserting the old input is rejected or no longer supported;
7. remove code, examples, docs, and tests for the compatibility path;
8. document rollback and operator impact.

Compatibility retirement is not delegated to a coding agent without the deployment evidence being supplied in the task.

## 5. Current code map to inspect

At minimum inspect the current main versions of:

### General ownership and configuration

- `AGENTS.md`;
- `agents.md`;
- `package.json` and `package-lock.json`;
- `tsconfig.json`;
- `scripts/arch-lint.sh`;
- `test/productionHygiene.test.ts`;
- `src/config.ts`;
- `src/bridge.ts`.

### CLI lifecycle and provider behaviour

- `src/cli.ts`;
- `src/types.ts` CLI option/result types;
- `src/engine.ts`;
- `src/messageDelivery.ts`;
- `src/runCommandAsync.ts` and worker subprocess paths;
- `src/advisor.ts`;
- `src/advisorBroker.ts`;
- `src/compactConversation.ts`;
- `src/fallbackCompaction.ts`;
- `src/providers/registry.ts`;
- `src/providers/selection.ts`;
- `src/providers/errorClassification.ts`;
- `src/providers/fallbackEligibility.ts`.

### Database and repositories

- `src/db.ts`;
- every file in `src/repositories/`;
- execution-lane migration and rollout documentation;
- conversation, compaction, advisor, worker queue, and run/event tests.

### Entry points and compatibility aliases

- `src/index.ts`;
- `src/index-interactive.ts`;
- `src/index-worker.ts`;
- `src/index-health.ts`;
- `src/index-discord-interactive.ts`;
- `scripts/install.sh`;
- `.env.*.example`;
- systemd units;
- platform-generated appliance defaults in the platform repository when compatibility retirement begins.

## 6. Dead-code and dependency audit policy

The audit tool is evidence, not an automatic deletion command.

Classify each finding as one of:

- genuine dead production code;
- public/compatibility export;
- dynamic entry point;
- test fixture;
- CLI script invoked from package scripts or systemd;
- future plan/document artifact;
- false positive requiring a narrow configuration entry.

Do not add blanket ignores for `src/**`, `scripts/**`, `bin/**`, or all exported symbols.

The first audit PR should publish:

- tool and version;
- exact command;
- reviewed configuration;
- baseline findings by category;
- deletions performed;
- findings deferred and why.

After the baseline is clean enough, make the scan mandatory in CI.

## 7. Documentation cleanup policy

`AGENTS.md` is canonical for repository operating instructions.

The lowercase `agents.md` must either:

- be deleted; or
- become a minimal redirect of a few lines if a verified external tool requires that exact casing.

It must not duplicate architecture, commands, lock semantics, deployment paths, or safety rules.

Historical research and completed plans should be moved under `docs/archive/` only when:

- no active issue or current architecture document links to them as authoritative;
- the archive move preserves Git history;
- active documentation links are updated;
- the move does not hide required rollout or rollback instructions.

Do not bulk-delete plans merely because their implementation merged.

## 8. Risk register

### R1: cancellation or timeout drift during runner consolidation

Mitigation:

- parity tests before implementation;
- one settlement state machine;
- full process-tree and leak diagnostics;
- retain public adapters.

### R2: conflict with Issue #133 worktree locking

Mitigation:

- Phase 2 blocked on #133;
- rebase and inspect exact merged supervisor interactions;
- assert lock holder/waiter cancellation through the same lifecycle;
- no second registry.

### R3: provider extraction changes CLI flags

Mitigation:

- invocation contract fixtures before moving code;
- live isolated advisor fallback smoke;
- provider-specific focused tests;
- no provider version upgrade in the same PR.

### R4: migration extraction corrupts existing databases

Mitigation:

- fixture databases representing historical schemas;
- transaction and failure injection tests;
- backup/restore instructions;
- no historical migration deletion in the extraction PR.

### R5: dead-code tooling removes dynamic entry points

Mitigation:

- classify findings manually;
- cover package scripts, `bin/`, systemd entry points, and test fixtures in configuration;
- never use automatic fix without diff review.

### R6: compatibility removal breaks unmanaged OSS installations

Mitigation:

- warnings and documentation first;
- minimum supported version policy;
- one deprecation window;
- release-note visibility;
- remove only with evidence and explicit approval.

## 9. Verification matrix

Every implementation PR:

```bash
npm test
npm run typecheck
bash scripts/arch-lint.sh src
git diff --check
```

PR 1 additionally:

```bash
npm run cleanup:check          # final script name may differ
npm run typecheck:unused       # audit command; may initially be non-CI
```

PR 2 additionally:

- focused CLI/process-tree/cancellation tests;
- Issue #133 concurrency and worktree-lock tests;
- advisor fallback isolated smoke;
- full parallel suite twice;
- full serial suite with leak diagnostics;
- explicit child/process-group leak check.

PR 3 additionally:

- provider invocation/parser suites;
- compaction recovery suites;
- advisor suites;
- interactive auth/fallback suites;
- isolated provider smokes where available.

PR 4 additionally:

- fresh DB tests;
- historical upgrade fixtures;
- failure injection during migration;
- foreign-key integrity checks;
- full repository/database suites twice.

A PR is not ready because focused tests pass. Exact-head CI and Architecture Lint must pass before merge.

## 10. Commit and PR discipline

For behavioural changes:

```text
commit 1: test: add failing <slice> cleanup/refactor contract
commit 2: refactor: implement <slice>
```

Repeat for coherent slices. Do not create one enormous red commit followed by one enormous green commit if the work can be reviewed independently.

PR descriptions must include:

- exact scope;
- explicit non-goals;
- red evidence;
- focused and full verification;
- compatibility impact;
- deployment impact;
- rollback;
- relationship to Issues #88, #133, and #135 where relevant.

Keep implementation PRs draft until all gates pass. Do not merge, deploy, restart services, mutate production databases, or remove compatibility without explicit approval.

## 11. Completion criteria for Issue #135

Issue #135 may close only when:

- the safe hygiene PR is merged;
- `runCli()` and `runCliAsync()` use one authoritative lifecycle implementation;
- provider policy has clear module ownership and `cli.ts` is no longer the catch-all owner;
- schema/migrations and remaining SQL domains have explicit owners;
- the broad bridge barrel is narrowed or has a documented compatibility boundary with enforcement against new misuse;
- dead-code/dependency checks run in CI with reviewed exceptions;
- each selected compatibility path is either retired with evidence or explicitly retained with a documented support policy;
- full verification and architecture checks are green on the final merged state;
- no production deployment or database mutation occurred without its own approved runbook.

## 12. First coding-agent assignment

The first implementation task is PR 1 only: safe hygiene and cleanup detection.

Do not begin the process-supervisor refactor in the same branch. After PR 1 is reviewed and merged, update Issue #135 with the audit findings and reassess Phase 2 against the exact merged result of Issue #133.
