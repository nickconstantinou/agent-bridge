# File Exchange via Telegram — Spike Findings & Implementation Plan

**Date:** 2026-06-03  
**Spike scope:** Validate 2-way file exchange (inbound image/file → CLI analysis, outbound generated file → Telegram) for all three CLIs: agy (Gemini), Claude, and Codex.

---

## 1. Spike Results

### 1.1 Inbound — image passed to CLI for analysis

| CLI | Mechanism | Works? | Notes |
|-----|-----------|--------|-------|
| **agy** | Local file path in prompt text | ✅ Yes | Reads file using its own tool chain (file viewer + Python analysis). Pixel-accurate analysis. |
| **Claude** | `--input-format stream-json --output-format stream-json --verbose` with base64 image payload | ✅ Yes | Accepts Anthropic multimodal message format exactly. Returns description in `result` field. |
| **Codex** | `-i <FILE>` flag on `codex exec` | ✅ Yes | Native `--image` / `-i` flag attaches images directly to initial prompt. Clean and explicit. |

**agy detail:** No dedicated flag needed. Dropping the file to a local path and writing `"analyze /tmp/bridge-uploads/<file>"` in the prompt is sufficient because agy's tool chain includes a file viewer and can spawn Python with PIL for analysis.

**Claude detail:** The `stream-json` input format expects JSON on stdin in this exact shape:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "image",
        "source": {
          "type": "base64",
          "media_type": "image/png",
          "data": "<base64-string>"
        }
      },
      { "type": "text", "text": "user's question" }
    ]
  }
}
```
Requires `--output-format stream-json --verbose`. Response is parsed from the `result` field of the last `{"type":"result"}` JSON line.

**Codex detail:** The `-i` flag is on the top-level `codex` command, not on `codex exec`. To use it non-interactively, pass prompt via stdin using `-`:
```bash
echo "describe this image" | codex exec --dangerously-bypass-approvals-and-sandbox -i /path/to/image.png -
```

---

### 1.2 Inbound — text/document files

| CLI | Works? | Notes |
|-----|--------|-------|
| **agy** | ✅ Yes | Reads any file at a path in the prompt. Handles CSV, JSON, plain text. |
| **Claude** | ✅ Yes (trusted mode) | `--dangerously-skip-permissions` is already set in trusted mode. Can read files in cwd and `/tmp`. |
| **Codex** | ✅ Yes | `--dangerously-bypass-approvals-and-sandbox` allows full disk read. |

---

### 1.3 Outbound — CLI generates a file, bridge sends it

| CLI | Works? | Notes |
|-----|--------|-------|
| **agy** | ✅ Yes | Writes files freely to any path including `/tmp`. Confirmed: text files, Python-generated PNGs, matplotlib-equivalent charts via PIL. |
| **Claude** | ✅ Yes (trusted mode) | Writes to cwd and approved paths. Needs `--dangerously-skip-permissions` (already set in trusted mode). |
| **Codex** | ✅ Yes | Full disk write in `danger-full-access` sandbox mode. |

**Key finding:** All three CLIs can write binary files (PNG, etc.) not just text. agy even generated a chart using PIL when matplotlib wasn't installed — it adapted autonomously.

---

### 1.4 Constraints and caveats

- **Claude stream-json is stateless** — it starts a new session each time. For image analysis follow-ups, the image would need to be passed again or the session continued with `--resume`.
- **agy local-path approach** — requires the file to exist at a path agy can reach. Works fine if bridge downloads to `/tmp` first.
- **Codex `-i` flag** — only on top-level `codex`, not `codex exec`. Reached via stdin `-` workaround: `echo "prompt" | codex exec -i file.png -`.
- **Permissions:** Claude only writes outside cwd when `--dangerously-skip-permissions` is set. This is already the case for trusted-mode sessions in the bridge.
- **No streaming for outbound detection** — the bridge must poll a known output directory or detect a file path in the CLI's response text.

---

## 2. Implementation Plan

All steps follow red → green → refactor. No production code is written before its failing test exists.

Decisions on open questions:
- **Claude session continuity:** Store session ID returned in `stream-json` result; use `--resume` for text follow-ups. Image will not be in context on subsequent turns — acceptable.
- **File size gate:** Reject attachments > 20 MB at download time (Telegram bot API limit).
- **Codex `-i` flag:** Confirmed in spike: `echo "prompt" | codex exec -i file -` works for new sessions. Resume path (`codex exec resume`) does not support `-i`; images are only supported on new sessions for Codex.
- **Output dir cleanup:** Immediate — delete each file after successful upload, remove dir after invocation.
- **MIME type detection:** Extension-based lookup (`image/jpeg`, `image/png`, `application/pdf`, etc.) with `application/octet-stream` fallback. No external dependency.

---

### Step 1 — Extend `TelegramMessage` type + `TelegramClient` download methods

**Files:** `src/types.ts`, `src/telegram.ts`, `test/telegram.test.ts`

**Red:** Add tests to `test/telegram.test.ts` asserting:
- `getFilePath(fileId)` calls `GET /getFile?file_id=<id>` and returns the `file_path` string from the response body.
- `downloadFile(filePath, destPath)` calls `GET https://api.telegram.org/file/bot{token}/{filePath}` and writes the response bytes to `destPath`.
- Both methods throw on non-2xx responses.

**Green:**
- Add `TelegramPhotoSize`, `TelegramDocument` interfaces to `src/types.ts`; extend `TelegramMessage` with `photo?: TelegramPhotoSize[]` and `document?: TelegramDocument`.
- Add `getFilePath(fileId: string): Promise<string>` and `downloadFile(filePath: string, destPath: string): Promise<void>` to `TelegramClient`.

**Refactor:** Extract the Telegram file base URL into a constant to avoid repeating the token interpolation.

---

### Step 2 — `downloadTelegramAttachment` utility

**Files:** `src/fileDownload.ts` (new), `test/fileDownload.test.ts` (new)

**Red:** Write `test/fileDownload.test.ts` with tests asserting:
- Given a message with `photo`, picks the last (largest) entry, calls `getFilePath` + `downloadFile`, returns `{ localPath, mimeType: "image/jpeg" }`.
- Given a message with `document`, uses `document.file_id`, preserves `file_name` in `localPath`, sets `mimeType` from `document.mime_type` (or extension fallback).
- Given a text-only message (no `photo` or `document`), returns `null`.
- Given a photo whose `file_size` exceeds 20 MB, returns `null` without calling the API.
- On `downloadFile` rejection, returns `null` (does not throw).

**Green:** Implement `downloadTelegramAttachment(client, message, destDir)` in `src/fileDownload.ts` satisfying all five assertions.

**Refactor:** Extract `mimeTypeFromExtension(filename: string): string` as a standalone pure function — testable independently and reusable by the upload path.

---

### Step 3 — Inbound: agy prompt injection

**Files:** `src/cli.ts`, `test/cli.test.ts`

**Red:** Add tests to `test/cli.test.ts` asserting:
- `buildCliInvocation({ bot: "antigravity", attachments: ["/tmp/x.jpg"], ... })` produces a prompt string containing `[Attached file saved at: /tmp/x.jpg]`.
- `buildCliInvocation({ bot: "antigravity", attachments: [], ... })` produces a prompt with no attachment annotation.
- Multiple attachments produce multiple annotation lines.

**Green:** Add `attachments?: string[]` to `buildCliInvocation` options. For `antigravity`, append one `[Attached file saved at: <path>]` line per attachment to the prompt text.

**Refactor:** Extract the annotation format string to a named constant so it can be referenced in the future output-dir prompt injection (Step 5).

---

### Step 4 — Inbound: Codex `-i` flag

**Files:** `src/cli.ts`, `test/cli.test.ts`

**Red:** Add tests asserting:
- `buildCliInvocation({ bot: "codex", attachments: ["/tmp/a.png", "/tmp/b.png"], ... })` produces args containing `["-i", "/tmp/a.png", "-i", "/tmp/b.png"]` before the prompt.
- `buildCliInvocation({ bot: "codex", attachments: [], ... })` produces no `-i` args.
- When `sessionId` is set (resume path) and attachments are present, a warning is logged and attachments are dropped — Codex does not support `-i` on resume.

**Green:** For `codex`, push `-i <path>` per attachment when no `sessionId` is present. When `sessionId` is set and attachments exist, log a warning and proceed without `-i`.

**Refactor:** None anticipated.

---

### Step 5 — Outbound: per-session output directory + prompt injection

**Files:** `src/fileOutput.ts` (new), `test/fileOutput.test.ts` (new), `src/cli.ts`

**Red:** Write `test/fileOutput.test.ts` asserting:
- `prepareOutputDir(chatId)` creates `/tmp/bridge-out/<chatId>/` and returns the path.
- `prepareOutputDir` called twice for the same chatId does not throw (idempotent).
- `collectOutputFiles(outDir)` returns an array of absolute paths for all files present in `outDir`.
- `collectOutputFiles` on a non-existent or empty dir returns `[]`.
- `cleanOutputDir(outDir)` deletes all files and removes the directory.

Add a test to `test/cli.test.ts` asserting that `buildCliInvocation` when given an `outputDir` appends the instruction `If you generate any files, save them to <outputDir>` to the prompt for all three bots.

**Green:**
- Implement `prepareOutputDir`, `collectOutputFiles`, `cleanOutputDir` in `src/fileOutput.ts`.
- Add `outputDir?: string` to `buildCliInvocation`; append the instruction for all bots when set.

**Refactor:** None anticipated.

---

### Step 6 — Outbound: `TelegramClient.sendDocument` / `sendPhoto`

**Files:** `src/telegram.ts`, `test/telegram.test.ts`

**Red:** Add tests asserting:
- `sendDocument(chatId, filePath, caption?)` makes a `POST /sendDocument` with `multipart/form-data` containing the file bytes and `chat_id`.
- `sendPhoto(chatId, filePath, caption?)` makes a `POST /sendPhoto` with `multipart/form-data`.
- Both methods throw on non-2xx response.

**Green:** Implement `sendDocument` and `sendPhoto` on `TelegramClient` using `FormData` / `fetch`.

**Refactor:** Extract the multipart upload logic into a private `sendFile(endpoint, chatId, filePath, caption?)` helper shared by both methods.

---

### Step 7 — Outbound: post-execution file upload

**Files:** `src/fileOutput.ts`, `test/fileOutput.test.ts`

**Red:** Add tests asserting:
- `uploadOutputFiles(outDir, chatId, client)` calls `sendPhoto` for `.png`/`.jpg` files and `sendDocument` for everything else.
- After a successful upload, the file is deleted.
- If `sendDocument`/`sendPhoto` throws, the error is caught, logged, and remaining files are still attempted.
- After all uploads, `cleanOutputDir` is called.

**Green:** Implement `uploadOutputFiles` in `src/fileOutput.ts`.

**Refactor:** None anticipated.

---

### Step 8 — Claude multimodal stream-json wrapper

**Files:** `src/claudeStreamJson.ts` (new), `test/claudeStreamJson.test.ts` (new), `src/cli.ts`

**Red:** Write `test/claudeStreamJson.test.ts` asserting:
- `buildClaudeStreamJsonInput(prompt, attachments)` returns a JSON string with the correct Anthropic multimodal message shape: `{ type: "user", message: { role: "user", content: [ { type: "image", source: { type: "base64", ... } }, { type: "text", text: prompt } ] } }`.
- Image MIME type is set from the file extension.
- Text-only call (no attachments) returns a plain `{ type: "user", message: { role: "user", content: prompt } }` shape.
- `parseClaudeStreamJsonOutput(stdout)` extracts the `result` string from the last `{"type":"result"}` JSON line.
- `parseClaudeStreamJsonOutput` returns `null` when no result line is present.

Add a test to `test/cli.test.ts` asserting that `buildCliInvocation` for Claude with attachments returns `{ inputFormat: "stream-json", stdin: "<json>" }` rather than plain `--print` args.

**Green:**
- Implement `buildClaudeStreamJsonInput` and `parseClaudeStreamJsonOutput` in `src/claudeStreamJson.ts`.
- In `buildCliInvocation` for Claude, when attachments are present: return args for `--input-format stream-json --output-format stream-json --verbose` and expose a `stdin` string for `runCli` to pipe.
- Extend `runCli` to accept an optional `stdin?: string` option and pipe it when present.

**Refactor:** The base64 encoding of image files is shared logic between the stream-json builder and potentially future MCP-based paths — extract to `encodeFileAsBase64(path: string): Promise<{ data: string; mimeType: string }>`.

---

### Step 9 — Integration: wire everything into `src/index.ts`

**Files:** `src/index.ts`

This step has no new units to test in isolation — all constituent parts are already covered. Integration testing is by manual smoke test against the live bot.

Wiring order per message:
1. Call `downloadTelegramAttachment` → `attachment | null`
2. Call `prepareOutputDir(chatId)` → `outDir`
3. Call `buildCliInvocation` with `attachments` and `outputDir`
4. Execute CLI via existing `runCli` path
5. Call `uploadOutputFiles(outDir, chatId, client)`
6. If `attachment`, delete the local upload file

---

## 3. File structure changes

```
src/
  types.ts              — add TelegramPhotoSize, TelegramDocument; extend TelegramMessage
  telegram.ts           — add getFilePath(), downloadFile(), sendDocument(), sendPhoto()
  fileDownload.ts       — NEW: downloadTelegramAttachment()
  fileOutput.ts         — NEW: prepareOutputDir(), collectOutputFiles(), uploadOutputFiles(), cleanOutputDir()
  claudeStreamJson.ts   — NEW: buildClaudeStreamJsonInput(), parseClaudeStreamJsonOutput()
  cli.ts                — extend buildCliInvocation() with attachments, outputDir; extend runCli() with stdin
  index.ts              — wire all above into message handler
test/
  telegram.test.ts      — extend with getFilePath, downloadFile, sendDocument, sendPhoto tests
  fileDownload.test.ts  — NEW (Step 2)
  fileOutput.test.ts    — NEW (Steps 5, 7)
  claudeStreamJson.test.ts — NEW (Step 8)
  cli.test.ts           — extend with attachment + outputDir tests (Steps 3, 4, 5, 8)
```

---

## 4. Open questions (resolved)

1. **Claude session continuity:** Session ID from `stream-json` result is stored and `--resume` used for follow-up text turns. Image not in context on subsequent turns — acceptable trade-off.
2. **File size limit:** Gate at 20 MB in `downloadTelegramAttachment` (Telegram bot API hard limit).
3. **Codex `-i` on resume:** Not supported — spike confirmed `-i` only works on new sessions. Bridge drops attachments and logs a warning when `sessionId` is set for Codex.
4. **Output dir cleanup:** Immediate per-file deletion after successful upload; directory removed after all files processed.
5. **MIME type:** Extension-based lookup, `application/octet-stream` fallback. No external dep.

---

## 5. Implementation order

Steps map directly to failing tests written first:

1. **Step 1** — `TelegramClient` download methods (type extension + `getFilePath` + `downloadFile`)
2. **Step 2** — `downloadTelegramAttachment` utility
3. **Step 3** — agy prompt injection in `buildCliInvocation`
4. **Step 4** — Codex `-i` flag in `buildCliInvocation`
5. **Step 5** — Output directory setup + prompt injection
6. **Step 6** — `sendDocument` / `sendPhoto` on `TelegramClient`
7. **Step 7** — Post-execution file upload
8. **Step 8** — Claude stream-json multimodal wrapper
9. **Step 9** — Integration wiring in `index.ts`
