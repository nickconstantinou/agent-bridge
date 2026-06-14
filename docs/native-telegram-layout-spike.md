# Native Telegram Layout Spike

## Executive Summary

The safe path is a hybrid native pipeline:

1. `sendMessage` with `parse_mode="HTML"` for normal responses and flattened
   tables.
2. `sendDocument` with an in-memory `response.md` for oversized logs,
   code-block-heavy answers, or anything that is better preserved as raw
   Markdown.
3. `sendDocument` with an in-memory `response.html` is useful as a visual
   experiment, but should not be assumed to render inline in Telegram clients.
4. Bot API 10.1 `sendRichMessage` is the first true native table path. It
   supports `RichBlockTable`, `RichBlockDetails`, headings, dividers,
   preformatted blocks, quotes, lists, math blocks, and draft streaming.
5. `sendPhoto` only for locally rendered image previews, generated from an
   in-memory buffer. Do not introduce hosted renderers or Telegraph.

The rejected Telegraph path failed the security model because it persisted
agent output outside our control. This spike keeps all transformations local.
It also avoids pretending Telegram is a browser: `sendMessage` HTML is an entity
parser, not a layout engine. Tables, arbitrary nested HTML, and `<details>` do
not belong in the standard `sendMessage parse_mode=HTML` path.

Prototype: `scripts/native-layout-spike.ts`

Tests: `test/nativeLayoutSpike.test.ts`

## Source Reality Check

Telegram Bot API `sendMessage` formatting supports basic entities:
bold, italic, underline, strikethrough, spoilers, block quotes, inline links,
custom emoji, date-time entities, inline code, `<pre>`, and nested
`<pre><code class="language-python">...</code></pre>`.

Relevant Bot API constraints:

- only the documented HTML tags are supported in `parse_mode="HTML"`
- raw `<`, `>`, and `&` must be escaped when not part of a supported tag/entity
- nested entities are restricted; `pre` and `code` cannot contain normal style
  entities
- blockquote and expandable blockquote entities cannot be nested
- standalone `<code>` cannot carry a language; language belongs inside
  `<pre><code class="language-*">`

Telegram also documents richer HTML with `<details>`, `<table>`, media blocks,
and richer block structures under `sendRichMessage`/rich message content. That
is a different API surface from ordinary `sendMessage parse_mode=HTML`. This
spike deliberately stays on the established native Bot API endpoints already
used by the bridge: `sendMessage`, `sendDocument`, and `sendPhoto`.

Primary references:

- https://core.telegram.org/bots/api#formatting-options
- https://core.telegram.org/bots/api#senddocument
- https://core.telegram.org/api/entities

## Architectural Diagram

```text
Agent text
   │
   ▼
Native layout router
   │
   ├─ Markdown table detected
   │      │
   │      ▼
   │   Table flattener
   │      │
   │      ▼
   │   HTML entity escape + vertical cards
   │      │
   │      ▼
   │   sendMessage(parse_mode="HTML")
   │
   ├─ >3500 chars or >3 code blocks
   │      │
   │      ▼
   │   Buffer.from(rawMarkdown)
   │      │
   │      ▼
   │   FormData document=response.md
   │      │
   │      ▼
   │   sendDocument
   │
   ├─ HTML file experiment requested
   │      │
   │      ▼
   │   <!doctype html> wrapper + native HTML body
   │      │
   │      ▼
   │   FormData document=response.html
   │      │
   │      ▼
   │   sendDocument
   │
   ├─ Bot API 10.1 rich layout supported
   │      │
   │      ▼
   │   Rich message HTML subset
   │      │
   │      ▼
   │   sendRichMessage / sendRichMessageDraft
   │
   └─ local image preview requested
          │
          ▼
       Buffer/Blob PNG
          │
          ▼
       FormData photo=response.png
          │
          ▼
       sendPhoto
```

## Component Breakdown

| Component | Role | Memory overhead | CPU trade-off | Dependency weight | Notes |
|---|---|---:|---|---|---|
| Table flattener | Converts Markdown tables into mobile-readable vertical cards | O(response size) | Low string scanning cost | None | Does not parse full Markdown; deliberately line-oriented |
| HTML escaper | Prevents Telegram entity parser failures and accidental markup | O(response size) | Low | None | Required for all raw agent text entering HTML mode |
| HTML sender | Sends compact native formatted text | Telegram 4096-char hard ceiling still applies | Low | Existing Bot API client | Good for short text and flattened tables |
| Document fallback | Preserves large raw Markdown as `response.md` | O(response size) Buffer | Low | Native `FormData`, `File`, `Blob` in Node 24 | No temp file; no host garbage |
| HTML document experiment | Sends a complete `response.html` document | O(response size) Buffer | Low | Native `FormData`, `File`, `Blob` in Node 24 | Accepted by Bot API, but client rendering is a Telegram app decision |
| Rich message probe | Sends native Bot API 10.1 rich layout | O(payload size) JSON | Low locally; server/client rendering unknown | Bot API 10.1 | Confirmed live with tables, details, and preformatted blocks |
| Photo fallback | Sends local visual previews | O(image size) Buffer | Depends on renderer, not payload wrapper | Native `FormData`, `File`, `Blob` | The spike only builds payloads; renderer is deliberately out of scope |

## 1. Table-Flattening Parser

### Problem

Markdown tables render badly on Telegram mobile. A four-column table that is
fine in GitHub becomes a horizontal-scroll or wrapped mess in chat. Telegram
HTML tables are not available in `sendMessage parse_mode=HTML`, and moving to a
hosted HTML renderer reintroduces the Telegraph privacy problem.

### Strategy

Detect simple GitHub-style Markdown tables by line scanning:

```text
| Service | Status |
|---|---|
| web-api | healthy |
```

Convert each row into a vertical card:

```html
<b>Service:</b> web-api
• <b>Status:</b> healthy
---
```

### Implementation Notes

- Detection requires a table row followed by a separator row containing at
  least two `---` cells.
- Cells are split on `|`; this is enough for operational status tables.
- Escaping happens after splitting so user-provided cell values cannot break
  Telegram HTML parsing.
- The function intentionally does not support escaped pipes, multiline cells,
  nested Markdown tables, or table alignment semantics beyond discarding the
  separator row.

Prototype functions:

- `hasMarkdownTable(markdown)`
- `flattenMarkdownTablesToCards(markdown)`
- `markdownToNativeHtml(markdown)`

## 2. In-Memory File Fallback (`sendDocument`)

### Problem

Long system logs, dense diffs, and code-heavy agent responses are worse when
chunked into multiple chat messages. They lose copy/paste coherence and produce
notification noise.

### Routing Threshold

The spike uses:

```ts
const DOCUMENT_LENGTH_THRESHOLD = 3500;
const DOCUMENT_CODE_BLOCK_THRESHOLD = 3;
```

Route to `sendDocument` when:

- raw Markdown length is greater than 3500 characters
- more than 3 fenced code blocks are present

### Payload Construction

The prototype builds the file entirely in memory:

```ts
const body = new FormData();
body.set("chat_id", String(chatId));
body.set("caption", "Full response attached as response.md");
body.set(
  "document",
  new File([Buffer.from(markdown, "utf8")], "response.md", {
    type: "text/markdown",
  }),
);
```

No temporary file is written to disk. That matters for CLI answers because the
response may include private code, stack traces, secrets accidentally pasted by
the user, or production incident context.

### Client Behavior To Verify Manually

The script can create the exact payload shape, but Telegram mobile/desktop
rendering is client-side behavior and must be visually checked in the target
clients:

- Mobile should show an attached `response.md` document with preview metadata.
- Desktop should open or save the Markdown file natively.
- Search/copy behavior should be compared against chunked messages.

### HTML File Variant

The spike also includes `buildNativeHtmlDocumentPayload()` for a controlled
`response.html` attachment test. It wraps already-sanitised native HTML in a
minimal document:

```ts
const body = new FormData();
body.set("chat_id", String(chatId));
body.set("caption", "Full response attached as response.html");
body.set(
  "document",
  new File([Buffer.from(documentHtml, "utf8")], "response.html", {
    type: "text/html",
  }),
);
```

This should be treated as an experiment, not a replacement for `sendMessage`.
Telegram accepts the file through `sendDocument`, but whether it previews,
opens in-app, downloads, or hands off to a browser depends on the client.
If inline visual fidelity is required, a locally generated image sent via
`sendPhoto` is more predictable than relying on HTML attachment rendering.

### Advanced HTML Live Trial

A browser-style HTML document containing `<!doctype>`, `<html>`, `<head>`,
`<style>`, a real `<table>`, `<details>`, `<summary>`, `<ul>`, `<code>`, and
`<blockquote>` was sent through two paths:

| Path | Result | Meaning |
|---|---|---|
| `sendDocument` as `response-advanced.html` | Accepted by Telegram | HTML files are viable as attachments |
| exact same string via `sendMessage parse_mode="HTML"` | Rejected with `400 Bad Request: can't parse entities: Unsupported start tag "!doctype"` | message-mode HTML is not browser HTML |

This confirms the routing boundary: full HTML belongs in an attachment or a
locally rendered image; `sendMessage parse_mode="HTML"` must receive only the
Telegram-supported entity subset.

## 3. Bot API 10.1 Rich Messages

Bot API 10.1 adds a separate rich-message model. This is not classic
`sendMessage parse_mode="HTML"`; it uses `sendRichMessage` and
`sendRichMessageDraft`.

### Confirmed Live Probe

The spike sent:

```html
<h2>Agent Bridge Rich Message Probe</h2>
<p><b>Goal:</b> validate Bot API 10.1 rich tables...</p>
<table bordered striped>
  <caption>Bridge service health</caption>
  <tr><th>Service</th><th>Status</th><th>Latency</th><th>Owner</th></tr>
  <tr><td>web-api</td><td><b>healthy</b></td><td align="right">12ms</td><td>platform</td></tr>
</table>
<details open>
  <summary>Diagnostics</summary>
  <pre><code class="language-text">route=rich-message</code></pre>
</details>
<blockquote>Expected result: native table plus expandable diagnostics.</blockquote>
```

Live Bot API results:

| Method | Result | Meaning |
|---|---|---|
| `sendRichMessageDraft` | OK | Ephemeral rich draft preview is available for private chats |
| `sendRichMessage` | OK | Persistent rich message with native table/details/pre block is available |

### Rich Capabilities To Explore Next

| Capability | Bot API object | Bridge use case |
|---|---|---|
| Native tables | `RichBlockTable`, `RichBlockTableCell` | Status reports, CI summaries, queue health, benchmark output |
| Collapsible diagnostics | `RichBlockDetails` | Long logs, stack traces, raw command output |
| Preformatted code/logs | `RichBlockPreformatted` | Dense CLI output without `.md` attachments |
| Headings/dividers | `RichBlockSectionHeading`, `RichBlockDivider` | Structure long agent responses |
| Lists/checklists | `RichBlockList`, `RichBlockListItem` | Task plans, rollout checklists, verification matrices |
| Quotes/callouts | `RichBlockBlockQuotation`, `RichBlockPullQuotation` | Decisions, warnings, incident summaries |
| Draft streaming | `sendRichMessageDraft` | Replace plain typing/progress messages with richer temporary previews |

### New Routing Proposal

```ts
if (clientSupportsRichMessages && responseHasTableOrDetails) {
  return sendRichMessage(toRichMessageHtml(response));
}

if (responseHasTable) {
  return sendMessage(flattenMarkdownTablesToCards(response), { parse_mode: "HTML" });
}

if (response.length > 3500 || codeBlockCount > 3) {
  return sendDocument(Buffer.from(response), "response.md");
}

return sendMessage(markdownToNativeHtml(response), { parse_mode: "HTML" });
```

This keeps Bot API 10.1 as an opportunistic enhancement, not a hard dependency.

## 4. Advanced HTML Formatting And Collapsible Blocks

### `sendMessage parse_mode="HTML"`

Safe subset for this spike:

- `<b>`, `<strong>`
- `<i>`, `<em>`
- `<u>`, `<ins>`
- `<s>`, `<strike>`, `<del>`
- `<tg-spoiler>` and `<span class="tg-spoiler">`
- `<a href="...">`
- `<code>`
- `<pre>`
- `<pre><code class="language-*">...</code></pre>`
- `<blockquote>`
- `<blockquote expandable>`

Do not emit:

- `<details>` / `<summary>` in `sendMessage parse_mode="HTML"`
- `<table>`, `<tr>`, `<td>`, `<th>` in `sendMessage parse_mode="HTML"`
- arbitrary `<div>`, `<span>` without Telegram-supported semantics
- `<br>` as a line-break crutch; use `\n`

### Known 400-Error Triggers

These structures should be expected to produce
`400 Bad Request: can't parse entities` or equivalent parse failures on the
standard `sendMessage parse_mode="HTML"` path:

| Structure | Why it fails |
|---|---|
| unescaped `&`, `<`, `>` in text | Telegram treats them as malformed HTML/entity input |
| unsupported tags such as `<details>` or `<table>` | not in the `sendMessage` HTML tag list |
| unbalanced tags | entity parser cannot build a valid range |
| overlapping entities | Telegram requires nesting, not partial overlap |
| styled text inside `<pre>` or `<code>` | `pre`/`code` cannot contain normal style entities |
| language on standalone `<code class="language-ts">` | language is only valid in nested `<pre><code ...>` |
| nested blockquotes | Bot API says blockquote entities cannot be nested |

### Rich Messages Are The Preferred Enhancement Path

The live Bot API 10.1 probe confirmed that rich messages are available to this
bot. They should now be treated as the preferred enhancement path for tables,
collapsible diagnostics, and preformatted operational output. The older
`sendMessage parse_mode="HTML"` path remains the compatibility fallback.

## Visual Proof Inputs

The script includes three deterministic test inputs:

| Input | Purpose | Expected route |
|---|---|---|
| `logDump` | 5000-ish character operational log | `sendDocument` |
| `table4Col` | 4-column Markdown table | `sendMessage` HTML after table flattening |
| `nestedList` | deeply nested list with unsafe HTML characters | `sendMessage` HTML with escaping |

Run:

```bash
./node_modules/.bin/tsx scripts/native-layout-spike.ts
```

The default mode prints payload summaries only. Live probes were run manually
through the Codex bot for this spike; production code should keep live sending
inside the normal Telegram client boundary, not inside the spike script.

## Routing Configuration Proposal

```ts
function routeAgentResponse(markdown: string) {
  const codeBlocks = countCodeBlocks(markdown);

  if (markdown.length > 3500 || codeBlocks > 3) {
    return sendDocument(Buffer.from(markdown, "utf8"), "response.md");
  }

  if (hasMarkdownTable(markdown)) {
    return sendMessage({
      text: flattenMarkdownTablesToCards(markdown),
      parse_mode: "HTML",
    });
  }

  return sendMessage({
    text: escapeHtml(markdown),
    parse_mode: "HTML",
  });
}
```

Ordering matters. Length/code-block fallback must run before table flattening
so a giant table or log with table-like fragments does not become a huge
multi-message HTML payload.

## Implementation Blueprint: Using Bot API 10.1

### Target Architecture

```text
Agent response text
   │
   ▼
Response classifier
   │
   ├─ tables / status matrix / diagnostic report
   │      ▼
   │   Rich layout compiler
   │      ▼
   │   sendRichMessage
   │
   ├─ live progress update
   │      ▼
   │   Rich draft compiler
   │      ▼
   │   sendRichMessageDraft
   │
   ├─ oversized raw logs / many code blocks
   │      ▼
   │   in-memory response.md
   │      ▼
   │   sendDocument
   │
   ├─ rich message rejected / unsupported client concern
   │      ▼
   │   table flattener + HTML escaper
   │      ▼
   │   sendMessage(parse_mode="HTML")
   │
   └─ normal short text
          ▼
       sendMessage(parse_mode="HTML")
```

### Production Modules

| Module | Responsibility | Notes |
|---|---|---|
| `src/nativeLayout.ts` | classify responses and choose route | Keep pure and unit-testable |
| `src/richMessage.ts` | compile structured layout into Bot API 10.1 rich HTML | No network calls |
| `src/telegram.ts` | add `sendRichMessage` and `sendRichMessageDraft` methods | Existing Bot API client boundary |
| `src/messageDelivery.ts` | call router, execute selected Telegram method, fallback on errors | Gate behind env flag first |
| `scripts/native-layout-spike.ts` | keep manual probes and visual fixtures | Remains isolated test harness |

### Feature Flags

| Env var | Default | Purpose |
|---|---|---|
| `TELEGRAM_RICH_MESSAGES_ENABLED` | `false` | Enables `sendRichMessage` final delivery |
| `TELEGRAM_RICH_DRAFTS_ENABLED` | `false` | Enables `sendRichMessageDraft` progress previews |
| `TELEGRAM_LAYOUT_DOCUMENT_THRESHOLD` | `3500` | Overrides document fallback length |
| `TELEGRAM_LAYOUT_CODE_BLOCK_THRESHOLD` | `3` | Overrides document fallback code-block count |

Start with both rich flags disabled. Current soak target is the unified
interactive bot because it exercises the switchable CLI path without changing
the dedicated Codex bot's production behavior. Copy the setting to dedicated
bots only after observing real interactive responses.

### Route Order

Recommended route order:

1. **Hard document fallback**: raw response is too large, too code-heavy, or
   explicitly marked as an artifact.
2. **Rich message**: response contains tables, diagnostics, status matrices,
   sections, or collapsible content and `TELEGRAM_RICH_MESSAGES_ENABLED=true`.
3. **Flattened HTML**: response contains tables but rich messages are disabled
   or rejected.
4. **Plain Telegram HTML**: normal short text.
5. **Last-resort plain text**: Telegram entity parsing fails after escaping.

Do not let rich-message support remove the document fallback. Large logs are
still better as files because they preserve copy/search and avoid chat spam.

### Rich Layout Compiler

The first production compiler should only support a small stable subset:

| Input pattern | Rich output |
|---|---|
| Markdown heading | `<h2>` / section heading |
| Markdown table | `<table bordered striped>` |
| Fenced code block | `<pre><code class="language-text">` |
| Long diagnostic appendix | `<details><summary>Diagnostics</summary>...` |
| Decision/warning paragraph | `<blockquote>` |

Avoid broad Markdown-to-HTML conversion. The bridge should compile known
agent-output structures into known Telegram rich blocks, not accept arbitrary
HTML from the model.

### Failure Handling

`sendRichMessage` failures must not lose the response. Fallback should be
deterministic:

```ts
try {
  return await telegram.sendRichMessage(chatId, richHtml);
} catch (err) {
  log.warn({ route: "rich", fallback: "native_html", reason: telegramErrorCode(err) });
}

try {
  return await telegram.sendMessage(chatId, flattenedOrEscapedHtml, { parse_mode: "HTML" });
} catch (err) {
  log.warn({ route: "native_html", fallback: "plain_text", reason: telegramErrorCode(err) });
  return telegram.sendMessage(chatId, stripFormatting(response));
}
```

Record the route, response length, table count, code-block count, and Telegram
error description. Do not log full response text.

### Draft Streaming Use

`sendRichMessageDraft` should be treated as a progress affordance, not durable
state:

- use it for “thinking / running command / compiling answer” style updates
- keep final answers on `sendRichMessage`, `sendDocument`, or `sendMessage`
- expire or replace drafts when the final answer is sent
- do not rely on drafts for audit/history

First draft payload:

```html
<tg-thinking>Running checks</tg-thinking>
```

Expanded draft payload after command execution:

```html
<p><b>Running:</b> npm test</p>
<pre><code class="language-text">test/nativeLayoutSpike.test.ts</code></pre>
```

### Test Plan

| Test class | Coverage |
|---|---|
| unit | table detection, rich compiler output, escaping, route decisions |
| integration with mocked Telegram | `sendRichMessage` success, 400 fallback, document fallback |
| live operator probe | private-chat visual rendering on mobile and desktop |
| regression | unsupported rich tag falls back without losing response |

### Acceptance Criteria

- Bot API 10.1 rich route is behind a feature flag.
- A table-heavy response renders as a rich native table when enabled.
- The same response falls back to flattened cards when rich delivery fails.
- Oversized logs still route to `sendDocument`.
- No external renderer, Telegraph page, or temp file is introduced.
- Logs record route metadata only, not response body content.

## Phased Implementation Roadmap

### Phase 1 — Pure Layout Router And Fallbacks

Scope:

- move table detection, HTML escaping, and document fallback into
  `src/nativeLayout.ts`
- keep all functions pure and covered by unit tests
- add route metadata: `rich|html|document|plain`, reason, length, table count,
  code-block count
- add `sendDocument` in-memory `response.md` fallback to the production
  delivery path, still behind a feature flag

Acceptance:

- unit tests cover table flattening and routing thresholds
- no temporary files are written during the response path
- no external rendering or hosting service is called

### Phase 2 — Rich Message Sender Behind Flag

Scope:

- add `sendRichMessage` and `sendRichMessageDraft` to `TelegramClient`
- add a narrow rich-message compiler for headings, tables, details,
  preformatted blocks, and blockquotes
- enable only with `TELEGRAM_RICH_MESSAGES_ENABLED=true`
- on any Telegram 400 or unsupported response, fall back to flattened
  `sendMessage parse_mode="HTML"`

Acceptance:

- table-heavy answers render as rich tables in the interactive private chat
- forced rich-message failure preserves the response via fallback
- telemetry shows route and fallback reason without logging full response text

### Phase 3 — Draft Progress Updates

Scope:

- use `sendRichMessageDraft` for progress previews when
  `TELEGRAM_RICH_DRAFTS_ENABLED=true`
- emit lightweight drafts for command execution and verification stages
- clear/replace drafts with the final durable answer path
- keep existing typing/progress behavior as fallback

Acceptance:

- draft failures do not affect final delivery
- private chat visual behavior is confirmed on mobile and desktop
- drafts are not used as source-of-truth state

### Phase 4 — Wider Rollout

Scope:

- keep rich messages enabled on the interactive bot for the initial soak
- then enable for dedicated Codex, Antigravity, and Claude bots one at a time
- document client quirks found during rollout
- keep the spike script as an operator regression harness

Acceptance:

- no increase in delivery failures
- rich-message fallback rate is visible in logs
- feature can be disabled without code changes

## Recommendation

Implement rich messages as an opportunistic delivery route, not as the only
route. The new API is good enough to justify production work, but the bridge
still needs boring fallbacks: `response.md` for large logs, flattened cards for
classic Telegram HTML, and plain text as the final escape hatch. `sendPhoto`
should remain a narrow path for locally rendered visual reports, not the default
table or log transport.
