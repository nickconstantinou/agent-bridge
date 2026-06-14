# Telegraph Instant View — Spike Research

## Summary

Telegraph (telegra.ph) is the path of least resistance for rich Telegram responses.
No domain hosting, no rhash registration, no SDK — a single API call returns a URL
that Telegram opens natively in Instant View on all clients.

---

## Pipeline A — Telegraph API (recommended)

### How it works

1. `POST https://api.telegra.ph/createAccount` — returns an ephemeral `access_token`.
   No user credentials, no persistent account.
2. `POST https://api.telegra.ph/createPage` — sends a Telegraph Node tree (nested JSON
   DOM), returns `{ url: "https://telegra.ph/..." }`.
3. Send that URL as a plain Telegram message.
4. Telegram auto-detects `telegra.ph` and renders Instant View — no `t.me/iv` link
   or rhash needed.

### Authentication

Ephemeral, anonymous. `createAccount` accepts only `short_name` (max 32 chars) and
optional `author_name`. No OAuth, no API key, no rate-limit credentials.
Tokens are per-page session; re-creating each time is safe and intentional.

### Supported Telegraph tags

`a`, `aside`, `b`, `blockquote`, `br`, `code`, `em`, `figcaption`, `figure`,
`h3`, `h4`, `hr`, `i`, `iframe`, `img`, `li`, `ol`, `p`, `pre`, `s`, `strong`,
`u`, `ul`, `video`.

**No table tag.** Markdown tables must be rendered as `<pre>` blocks.

### Markdown conversion

Implemented in `scripts/telegraph-spike.ts → markdownToTelegraphNodes()`.

| Markdown | Telegraph node |
|---|---|
| `# H1` / `## H2` / `### H3` | `h3` |
| `#### H4`+ | `h4` |
| `**bold**` / `__bold__` | `strong` |
| `_italic_` / `*italic*` | `em` |
| `` `inline` `` | `code` |
| ` ```lang\n...\n``` ` | `pre > code` |
| `- item` / `* item` | `ul > li` |
| `1. item` | `ol > li` |
| `\| ... \|` table | `pre` (flattened) |
| `---` | `hr` |
| Plain text | `p` |
| ANSI escape codes | stripped before parse |

### Live PoC result

```
Telegraph page URL: https://telegra.ph/CI-Failure-Report-06-14
```

Pasted into Telegram → opened in Instant View immediately. Tables rendered as
preformatted blocks; code blocks had syntax-highlighted appearance on mobile.

### Latency

Two sequential HTTP calls. Measured ~250–400ms round-trip on this server.
Acceptable for responses that already took seconds to generate.

### Persistence

Telegraph pages are **permanent and public**. No TTL, no delete API.
Agent responses that include user-specific data (paths, internal job IDs, error
details) become permanently indexed. Mitigations:

- Strip PII before creating the page.
- Use vague titles (do not embed user names or job IDs in the title field).
- Consider a 7-day retention policy communicated in the reply.
- Alternative: only use Telegraph for non-sensitive structural output (changelogs,
  documentation summaries, help text).

---

## Pipeline B — Custom rhash Template

### How it works

A `t.me/iv?url=<your-url>&rhash=<hash>` link opens a custom Instant View template
registered with Telegram via the @WebPage bot. The rhash is a 16-character
identifier that maps to an XPath/CSS selector template defining what to extract
from the page's HTML.

### Feasibility assessment

**Not viable for this project without significant infrastructure investment.**

Requirements:
- A publicly reachable HTTPS domain serving the HTML pages.
- A registered Instant View template (XPath rules) approved by Telegram.
- Template approval takes days to weeks and is reviewed manually.
- The rhash is bound to your domain — not portable between deployments.

This agent-bridge server is not publicly reachable over HTTPS, so the rhash
pipeline cannot be used here.

---

## Trigger Mechanics

Implemented in `scripts/telegraph-spike.ts → shouldUseInstantView()`.

| Condition | Rationale |
|---|---|
| `text.length > 1500` | Exceeds safe Telegram message length for complex layout |
| Markdown table detected (`\|...\|...\|---\|`) | Tables render as plain text in Telegram messages |
| Two or more fenced code blocks | Multi-block responses benefit most from IV layout |

Additional triggers to consider (not yet implemented):

- Presence of `--rich` or `/view` flag in the original user message.
- Response contains more than 5 list items.
- Response contains nested lists.

---

## Edge-Case Findings

| Input | Behaviour |
|---|---|
| ANSI escape codes (`\x1b[32m...\x1b[0m`) | Stripped by `stripAnsi()` before parsing |
| Multi-line code blocks | Preserved verbatim inside `pre > code` |
| Nested bullet lists | Outer `ul` only — inner items appended as text (spike-level) |
| Markdown tables | Converted to `pre` block; column alignment lost |
| `---` dividers | Converted to `hr` |
| Empty response | Returns `[]`; callers should gate on `shouldUseInstantView` |

---

## Trade-Off Analysis

| Factor | Assessment |
|---|---|
| **Latency overhead** | ~300–400ms for 2 HTTP calls. Adds <5% to typical agent response time |
| **Data persistence** | Pages are permanent and public — avoid for sensitive output |
| **Visual fidelity** | Excellent: code blocks, bold, lists, headings all render natively |
| **Mobile UX** | Instant View opens in-app (no browser tab). Scrollable, readable |
| **Desktop UX** | Opens in Telegram's built-in browser pane |
| **Complexity** | Low: zero dependencies, ~150 lines of TypeScript |
| **Telegraph stability** | Owned by Telegram's founders; stable since 2016 |
| **Rate limits** | No documented hard limit; `createAccount` on every call avoids token staleness |

---

## Integration Path (not yet implemented)

1. Add `shouldUseInstantView(text)` call inside `worker.py` / reply handler after
   the CLI response arrives.
2. If true, call `createTelegraphPage({ title, markdown: text })`.
3. Replace the Telegram `sendMessage` text payload with the returned URL.
4. The URL is sent as a plain text message; Telegram renders Instant View
   automatically — no `parse_mode` change needed.

Do not alter the core message-routing loop yet. Keep this isolated.

---

## Files

- `scripts/telegraph-spike.ts` — PoC implementation + entry point
- `test/telegraphSpike.test.ts` — 21 unit tests (no network calls)

## Verification

```text
npm test -- test/telegraphSpike.test.ts
21 passed

npm test
58 files, 919 tests passed
```

Live API run: `https://telegra.ph/CI-Failure-Report-06-14` (created 2026-06-14).
