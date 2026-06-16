# Shared Markdown IR for Telegram + Discord rendering

## Problem

`DiscordClient.sendMessage` (`discord.ts:74`) posts raw markdown straight to
Discord's REST API. Discord does not render GFM pipe-tables, so any reply
containing a table shows as broken `| a | b |` text. Telegram has working
table rendering (`nativeLayout.ts`), but it's Telegram-specific string
transforms (`flattenMarkdownTablesToCards`, `markdownTableToRichHtml`) with no
shared structure Discord can reuse.

Separately, Telegram itself has two independent rendering paths today:

- Default path: `toTelegramEntitiesText()` (`render.ts:106`) produces a
  `{text, entities}` pair sent with no `parse_mode` — Telegram's `entities`
  array describes formatting by offset/length over untouched raw text.
- Rich/table path: `nativeLayout.ts` produces HTML marker strings
  (`<b>`, `<table>`) sent with `parse_mode: "HTML"`.

## Goal

Introduce one shared markdown parser (an IR) that both platforms render from,
so adding/maintaining formatting rules happens once instead of per-platform.
Use it to give Discord real table support. Migrate Telegram's rich/HTML path
onto the same IR. Keep Telegram's entities path's *output* unchanged, but have
it consume the same IR rather than its own ad hoc parsing.

Gate all of this behind feature flags so either platform can fall back to its
existing, currently-shipping renderer with no code change if a regression
shows up.

## Decision: keep two renderer backends, not one

OpenClaw's pattern (the inspiration for this work) uses a single
marker-table renderer for every channel. A spike
(adversarial samples: angle brackets in prose, ampersands, code blocks with
embedded HTML-like text, bold spans containing special characters, emoji)
showed why that doesn't transfer directly to Telegram's default path:

- The entities approach is safe by construction — body text is sent
  completely untouched, so there is no escaping to get wrong. All 5 adversarial
  samples round-tripped correctly, including an emoji/UTF-16 offset check
  (Telegram entity offsets are UTF-16 code units; JS string `.slice` already
  uses UTF-16 code units, so this already works correctly).
- A naive single-renderer port (insert `<b>` markers, then HTML-escape
  everything) **breaks**: the markers themselves get escaped into visible
  `&lt;b&gt;...&lt;/b&gt;` text. This was reproduced, not theoretical.
- A corrected single-renderer (escape text segments individually, insert
  markers raw) works, but requires every renderer/marker-table combination to
  maintain that escape-before-mark-after ordering correctly, forever. The
  entities approach has no equivalent ongoing risk.

Conclusion: parse once into a shared IR (matches OpenClaw), but render with
**two** backends — a marker-string renderer (Discord, Telegram rich/table
path) and an entities renderer (Telegram default path, replacing
`toTelegramEntitiesText` with IR-driven logic that produces byte-identical
output for existing inputs).

## Architecture

```
markdown text
     │
     ▼
parseMarkdownToIR()        src/markdownIR.ts (new)
     │
     ├──► renderMarkerString(ir, markerTable)   src/markdownIR.ts (new)
     │         ├─ DISCORD_MARKERS   → discord.ts sendMessage
     │         └─ TELEGRAM_HTML_MARKERS → nativeLayout.ts rich/table path
     │
     └──► renderTelegramEntities(ir)            src/render.ts (new function)
               → messageDelivery.ts default path
```

### IR node types

Scoped to what the codebase actually renders today — no speculative types:

- `text` — plain string
- `bold` — `**...**`
- `code_inline` — `` `...` ``
- `code_block` — ` ```lang\n...\n``` `
- `heading` — `#`/`##`/`###` (Telegram already flattens these to bold; Discord
  renders `#` headings natively, so the Discord marker table maps `heading` to
  itself)
- `table` — GFM pipe table (header row + separator + data rows)
- `list` — bullet list items

### Files

| File | Change |
|---|---|
| `src/markdownIR.ts` | **New.** `parseMarkdownToIR(markdown): IRNode[]`, `renderMarkerString(ir, markerTable): string`, marker table type, `DISCORD_MARKERS`, `TELEGRAM_HTML_MARKERS` constants. |
| `src/render.ts` | Add `renderTelegramEntitiesFromIR(ir): {text, entities}`. Existing `toTelegramEntitiesText` stays as-is (legacy fallback). |
| `src/nativeLayout.ts` | Unchanged. Existing functions stay as legacy fallback. |
| `src/discord.ts` | `sendMessage` branches on `DISCORD_MARKDOWN_IR_ENABLED`: on → parse + `renderMarkerString` with `DISCORD_MARKERS`; off → current raw passthrough. |
| `src/messageDelivery.ts` | Default-path branch on `TELEGRAM_MARKDOWN_IR_ENABLED`: on → parse + `renderTelegramEntitiesFromIR`; off → `toTelegramEntitiesText`. Rich/table path branch on the same flag: on → `renderMarkerString` with `TELEGRAM_HTML_MARKERS`; off → existing `nativeLayout.ts` calls. |

### Feature flags

- `DISCORD_MARKDOWN_IR_ENABLED` (default off)
- `TELEGRAM_MARKDOWN_IR_ENABLED` (default off)

Independent per platform. Rollback is a flag flip — no code revert needed.
Both legacy code paths remain in the codebase until each flag has been on in
production long enough to trust, at which point removing the legacy path is a
separate, later cleanup (not part of this work).

## Explicitly out of scope

- Replacing `splitTelegramText`'s chunking heuristics with IR-aware structural
  slicing (OpenClaw does this; chunking isn't broken today, only table
  rendering is — separate follow-up if ever needed).
- A typed `ChannelPlugin` registry / full plugin system. Two channels does not
  justify that scope.
- Nested/overlapping inline formatting (e.g. bold+italic combined) — neither
  existing renderer supports this today, and no current consumer needs it.

## Testing

- Parser: one test per IR node type (markdown → IR).
- Marker renderer: IR → string for each of `DISCORD_MARKERS` and
  `TELEGRAM_HTML_MARKERS`, including the 5 adversarial samples from the spike.
- Entities renderer: IR → `{text, entities}` compared against current
  `toTelegramEntitiesText` output for the same inputs — must match exactly.
- Flag-off regression: with both flags off, `discord.ts` and
  `messageDelivery.ts` behavior is provably unchanged (existing test suite
  must still pass unmodified).
