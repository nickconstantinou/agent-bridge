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

### Phase 1 — Inbound: images and documents (Telegram → CLI)

**Scope:** User sends a photo or file to the Telegram bot. Bridge downloads it, passes to whichever CLI is active for that chat, returns text analysis.

#### 2.1 Extend `TelegramMessage` type

Add optional fields to `src/types.ts`:

```typescript
export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  // ... existing fields ...
  photo?: TelegramPhotoSize[];    // array, largest is last
  document?: TelegramDocument;
}
```

#### 2.2 Add `TelegramClient.downloadFile(fileId)` method

```typescript
async getFilePath(fileId: string): Promise<string> {
  // GET /bot{token}/getFile?file_id={fileId}
  // Returns { file_path: "photos/file_XYZ.jpg" }
}

async downloadFile(filePath: string, destPath: string): Promise<void> {
  // GET https://api.telegram.org/file/bot{token}/{filePath}
  // Streams to destPath
}
```

#### 2.3 Add file download utility (`src/fileDownload.ts`)

```typescript
export async function downloadTelegramAttachment(
  client: TelegramClient,
  message: TelegramMessage,
  destDir: string,
): Promise<{ localPath: string; mimeType: string } | null>
```

Logic:
- If `message.photo`: use largest size (`photo[photo.length - 1]`), download as `.jpg`
- If `message.document`: use `document.file_id`, preserve `file_name`
- Return `null` for unsupported types or download failure
- Clean up file after CLI invocation completes

#### 2.4 Extend `buildCliInvocation` in `src/cli.ts`

Add optional `attachments?: string[]` parameter:

```typescript
// codex: adds -i flag per image attachment
if (bot === "codex" && attachments?.length) {
  for (const path of attachments) args.push("-i", path);
}

// claude: uses stream-json multimodal input (see §2.5)
// agy: appends "[Attached file: /path/to/file]" to prompt text
```

#### 2.5 Claude stream-json wrapper (`src/claudeStreamJson.ts`)

New helper that:
1. Builds a multimodal `stream-json` message from text + attachment paths
2. Spawns claude with `--input-format stream-json --output-format stream-json --verbose`
3. Pipes the JSON to stdin
4. Parses the `{"type":"result"}` line from stdout
5. Returns the `result` string

Used by `buildCliInvocation` when `bot === "claude"` and attachments are present. Falls back to standard `--print` mode when no attachments.

#### 2.6 Prompt injection for agy

agy doesn't need a separate code path. When attachments are present, append to prompt:

```
[Attached file saved at: /tmp/bridge-uploads/chat_12345_img_1.jpg]
```

agy will read it using its tool chain.

#### 2.7 Integration point in `src/index.ts`

In the message handler, before invoking the CLI:

```typescript
const attachment = await downloadTelegramAttachment(client, message, UPLOAD_DIR);
const prompt = buildUserPrompt(rawText, attachment);
const { command, args } = buildCliInvocation({ ..., attachments: attachment ? [attachment.localPath] : [] });
// ... existing execution flow ...
// After result: cleanup attachment file
```

---

### Phase 2 — Outbound: CLI-generated files → Telegram

**Scope:** When a CLI writes a file to the designated output directory, bridge detects it and sends it as a Telegram document or photo.

#### 2.8 Per-session output directory

Bridge creates `/tmp/bridge-out/<chatId>/` before each CLI invocation. Appended to prompt:

```
If you generate any files, write them to /tmp/bridge-out/12345678/
```

After CLI completes, scan the directory. Any files found are:
- Sent to the chat as `sendDocument` (or `sendPhoto` for `.jpg`/`.png`)
- Deleted from the temp dir

#### 2.9 Add `TelegramClient.sendDocument(chatId, filePath, caption?)` method

Uses `multipart/form-data` POST to `/sendDocument` or `/sendPhoto`.

#### 2.10 Response parsing for file hints (optional enhancement)

Scan CLI output text for patterns like `saved to /path/file.ext` or `written to /path/file.ext`. If the path exists and wasn't in the output dir, copy it there. This catches cases where the CLI writes to its cwd.

---

### Phase 3 — Voice messages (future)

Not in scope for this implementation, but the pattern is clear:
- Detect `message.voice` (OGG Opus)
- Download and pass to Whisper for transcription
- Inject transcript as text prompt

---

## 3. File structure changes

```
src/
  types.ts              — add TelegramPhotoSize, TelegramDocument, extend TelegramMessage
  telegram.ts           — add getFilePath(), downloadFile(), sendDocument(), sendPhoto()
  fileDownload.ts       — NEW: downloadTelegramAttachment() utility
  claudeStreamJson.ts   — NEW: multimodal stream-json wrapper for Claude
  cli.ts                — extend buildCliInvocation() with attachments param
  index.ts              — wire download + output dir + upload into message handler
test/
  fileDownload.test.ts  — NEW
  claudeStreamJson.test.ts — NEW
```

---

## 4. Open questions

1. **Session continuity for Claude image analysis:** The `stream-json` path starts a new session. Should we store the session ID and use `--resume` for follow-ups, accepting that the image won't be in context for subsequent turns?
2. **File size limits:** Telegram bots can send files up to 50 MB. Should we gate on Telegram's 20 MB download limit for user-sent files?
3. **Codex `-i` flag vs stdin prompt:** The `-i` flag is on `codex` top-level, but bridge uses `codex exec`. Confirm the workaround (`echo "prompt" | codex exec -i file -`) works in all session states (new vs resume).
4. **Output directory cleanup:** Should cleanup be immediate (after upload) or deferred (on bot restart)? Immediate is safer for disk space.
5. **MIME type detection:** For agy/Claude, MIME type matters for correct prompt construction. Use `file --mime-type` or a Node.js magic-bytes approach?

---

## 5. Recommended implementation order

1. `TelegramMessage` type extension + `getFilePath`/`downloadFile` (no behaviour change, safe)
2. `downloadTelegramAttachment` utility with tests
3. agy path (simplest — prompt injection only)
4. Outbound file detection + `sendDocument`
5. Codex `-i` flag integration
6. Claude `stream-json` multimodal wrapper (most complex, validate last)
