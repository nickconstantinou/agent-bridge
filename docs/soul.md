# SOUL.md Design

`SOUL.md` is the proposed bridge-level persona contract for all CLI-backed agents.

The bridge should treat it as runtime context, not as another agent-specific instruction file. It should be loaded by `agent-bridge`, compacted into a small prompt block, and injected on every user turn for Codex, Antigravity, and Claude.

## Goals

- Give all agents a consistent voice, values, and operating posture.
- Keep persona separate from durable memory, installed skills, and per-CLI configuration.
- Re-apply the persona automatically after `/reset`, because every new turn rebuilds the prompt wrapper from scratch.
- Make the feature easy to disable, shorten, or replace without editing `AGENTS.md`, `ANTIGRAVITY.md`, or `CLAUDE.md`.

## Non-goals

- `SOUL.md` must not override bridge safety, auth, process controls, system prompts, or higher-priority instructions.
- `SOUL.md` is not long-term memory. Durable facts belong in shared memory.
- `SOUL.md` is not a skill registry. Tools and workflow skills belong in the shared skills system.

## The 9 sections that make SOUL.md work

A useful `SOUL.md` should be structured around these sections.

### 1. Identity

Who the agent is, not just what it does.

Good content:
- Name or persona
- Role identity
- General posture toward the user
- Signature tone or motif

Avoid:
- Vague labels like “helpful assistant” with no behavioural consequence
- Claims that imply real-world body, life, or human status

### 2. Values

Decision-making principles for situations where explicit rules do not cover the case.

Good content:
- Safety before speed
- Clarity over cleverness
- Preserve user trust
- Admit uncertainty
- Prefer reversible actions when risk is unclear

### 3. Communication Style

How the agent should sound and structure replies.

Good content:
- Tone
- Length preference
- Formality level
- When to be brief vs. detailed
- How to handle stress, ambiguity, or good news

### 4. Expertise

Specific tools, domains, and workflows the agent is good at.

Good content:
- Concrete domains, such as TypeScript, Flutter, systemd, Google Workspace, Telegram bots, publishing workflows
- Preferred technical patterns
- Known operating environments

Avoid:
- Generic “knows everything” claims

### 5. Boundaries

The immune system. These rules should hold even under pressure.

Good content:
- Do not bypass safeguards
- Do not invent credentials or access
- Ask before destructive production actions
- Never leak secrets
- Do not claim capabilities that do not exist

### 6. Workflow

The step-by-step process for handling tasks.

Good content:
- Discover before changing
- Test before push
- Prefer red-green-refactor for behaviour changes
- Verify after restart/deploy
- Summarise what changed and what remains

### 7. Tool Usage

When and how tools should be used, not just which tools exist.

Good content:
- Use shell only for work that starts now
- Use cron for future work
- Use Git safely with clean status checks
- Use first-class bridge tools rather than ad-hoc provider calls
- Prefer fewer, larger external writes where APIs may rate-limit

### 8. Memory Policy

What persists and what gets wiped.

Good content:
- Save durable project facts, decisions, bug fixes, conventions, and unresolved follow-ups
- Do not save secrets, transient logs, or sensitive personal data
- Re-check memory before answering questions about prior work or preferences
- Treat `/reset` as conversation reset, not persona or policy reset

### 9. Example Interactions

One good example beats ten abstract rules.

Good content:
- A strong example of a concise operational update
- A strong example of saying “no” safely
- A strong example of asking a clarifying question only when needed
- A strong example of reporting test/deploy status

Keep examples short. The bridge should include at most one or two examples in compact prompt mode.

## Runtime injection model

Recommended order for the prompt wrapper:

```text
Soul contract:
<compact SOUL.md summary>

Telegram response style:
<shared Telegram formatting rules>

User request:
<original user message>
```

For Antigravity, the delimiter wrapper remains outside that:

```text
You are being called by agent-bridge in non-interactive print mode.
When ready, output a line containing only ***.
After that line, output only the user-facing final answer.

Soul contract:
...

Telegram response style:
...

User request:
...
```

The bridge should rebuild this prompt every turn. That means after `/reset`, the next conversation starts fresh but still receives the same Soul contract.

## Suggested configuration

```bash
AGENT_BRIDGE_SOUL_PATH=/path/to/agent-bridge/SOUL.md
AGENT_BRIDGE_SOUL_MODE=summary   # summary | full | off
```

Recommended default:

- `summary` for normal operation
- `full` for experiments or rich persona steering
- `off` for debugging raw model behaviour

## Loading and safety rules

- Load `SOUL.md` once at startup or lazily with a small cache.
- Missing file should be a no-op, never a startup failure.
- Cap total injected Soul context, for example 2–4 KB in summary mode and 8–12 KB in full mode.
- Preserve section order when compacting.
- Higher-priority bridge/system/developer instructions always win.
- Do not write `SOUL.md` into `AGENTS.md`, `ANTIGRAVITY.md`, or `CLAUDE.md`; keep it bridge-level and runtime-injected.

## Relationship to existing systems

- **Shared memory** stores durable project facts and decisions.
- **Shared skills** install reusable procedural capabilities into each CLI.
- **SOUL.md** defines persona, values, boundaries, communication style, and operating posture.

These should remain separate so each mechanism can evolve independently.
