import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  adaptDiscordAudioMessage,
  adaptTelegramAudioUpdate,
  type InteractiveTurnInput,
} from "../src/interactiveIngress.js";
import {
  prepareVoiceTurn,
  reapStaleVoiceTempDirs,
  unavailableVoiceTranscriber,
  type VoiceTranscriber,
} from "../src/voiceIngress.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function audioTurn(overrides: Partial<InteractiveTurnInput> = {}): InteractiveTurnInput {
  return {
    surfaceIdentity: "telegram:interactive",
    chatKey: "-100123:99",
    actorId: "42",
    messageId: "9",
    text: "Please review this",
    threadId: "99",
    delivery: { chatId: -100123, chatType: "supergroup" },
    attachments: [{
      kind: "audio",
      fileId: "voice-file",
      fileName: "voice_voice-file.ogg",
      mimeType: "audio/ogg",
      fileSize: 6,
      durationSeconds: 18,
    }],
    ...overrides,
  };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "agent-bridge-voice-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("voice ingress", () => {
  it("represents Telegram voice metadata, caption and topic without changing ordinary Telegram ingress", () => {
    const update = {
      update_id: 8,
      message: {
        message_id: 9,
        chat: { id: -100123, type: "supergroup" },
        from: { id: 42, first_name: "owner" },
        message_thread_id: 99,
        caption: "Please review this",
        voice: { file_id: "voice-file", file_unique_id: "voice-unique", duration: 18, mime_type: "audio/ogg", file_size: 12345 },
      },
    } as any;

    expect(adaptTelegramAudioUpdate(update, "telegram:interactive", "-100123:99")).toMatchObject({
      text: "Please review this",
      threadId: "99",
      attachments: [{
        kind: "audio",
        fileId: "voice-file",
        fileName: "voice_voice-file.ogg",
        mimeType: "audio/ogg",
        fileSize: 12345,
        durationSeconds: 18,
      }],
    });
  });

  it("represents Discord audio-only messages on the same neutral shape", () => {
    const turn = adaptDiscordAudioMessage({
      id: "123456789012345678",
      channel_id: "223456789012345678",
      guild_id: "323456789012345678",
      author: { id: "423456789012345678", username: "owner" },
      content: "",
      attachments: [{
        id: "523456789012345678",
        filename: "note.ogg",
        content_type: "audio/ogg",
        size: 23456,
        url: "https://cdn.discordapp.com/attachments/1/2/note.ogg",
        duration_secs: 12.5,
      }],
    });

    expect(turn).toMatchObject({
      text: "",
      attachments: [{
        kind: "audio",
        fileId: "523456789012345678",
        fileName: "note.ogg",
        mimeType: "audio/ogg",
        fileSize: 23456,
        remoteUrl: "https://cdn.discordapp.com/attachments/1/2/note.ogg",
        durationSeconds: 12.5,
      }],
    });
  });

  it("fails explicitly before download when the STT backend is unavailable", async () => {
    const stager = { stage: vi.fn() };
    const result = await prepareVoiceTurn(audioTurn(), {
      transcriber: unavailableVoiceTranscriber,
      stager,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "unavailable", reason: "Voice-note transcription is not configured on this runtime." });
    expect(stager.stage).not.toHaveBeenCalled();
  });

  it("turns caption plus transcript into one ordinary turn and cleans temporary audio", async () => {
    await withTempRoot(async (root) => {
      let operationDir = "";
      const stager = {
        stage: vi.fn(async ({ operationDir: dir }: { operationDir: string }) => {
          operationDir = dir;
          const file = join(dir, "input.ogg");
          await writeFile(file, "audio");
          return file;
        }),
      };
      const transcriber: VoiceTranscriber = {
        name: "fake",
        available: true,
        transcribe: vi.fn(async () => ({ text: "Review issue 684." })),
      };

      const result = await prepareVoiceTurn(audioTurn(), {
        transcriber,
        stager,
        signal: new AbortController().signal,
        tempRoot: root,
      });

      expect(result).toMatchObject({
        kind: "ready",
        turn: {
          text: "Please review this\n\n[Voice note transcript]\nReview issue 684.",
          threadId: "99",
          attachments: [],
        },
      });
      expect(operationDir).not.toBe("");
      expect(await pathExists(operationDir)).toBe(false);
    });
  });

  it("fences a late transcription completion after cancellation and cleans the operation directory", async () => {
    await withTempRoot(async (root) => {
      const controller = new AbortController();
      let operationDir = "";
      let resolveTranscript!: (value: { text: string }) => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const transcript = new Promise<{ text: string }>((resolve) => { resolveTranscript = resolve; });
      const stager = {
        stage: vi.fn(async ({ operationDir: dir }: { operationDir: string }) => {
          operationDir = dir;
          const file = join(dir, "input.ogg");
          await writeFile(file, "audio");
          return file;
        }),
      };
      const transcriber: VoiceTranscriber = {
        name: "fake",
        available: true,
        transcribe: vi.fn(async () => {
          markStarted();
          return transcript;
        }),
      };

      const pending = prepareVoiceTurn(audioTurn(), {
        transcriber,
        stager,
        signal: controller.signal,
        tempRoot: root,
      });
      await started;
      controller.abort();
      resolveTranscript({ text: "This must never become a Run." });

      expect(await pending).toEqual({ kind: "cancelled" });
      expect(await pathExists(operationDir)).toBe(false);
    });
  });

  it("cleans temporary audio when transcription fails", async () => {
    await withTempRoot(async (root) => {
      let operationDir = "";
      const stager = {
        stage: vi.fn(async ({ operationDir: dir }: { operationDir: string }) => {
          operationDir = dir;
          const file = join(dir, "input.ogg");
          await writeFile(file, "audio");
          return file;
        }),
      };
      const transcriber: VoiceTranscriber = {
        name: "fake",
        available: true,
        transcribe: vi.fn(async () => { throw new Error("decoder failed"); }),
      };

      const result = await prepareVoiceTurn(audioTurn(), {
        transcriber,
        stager,
        signal: new AbortController().signal,
        tempRoot: root,
      });

      expect(result.kind).toBe("failed");
      expect(result.kind === "failed" ? result.error.message : "").toBe("decoder failed");
      expect(await pathExists(operationDir)).toBe(false);
    });
  });

  it("reaps only stale managed voice directories after restart", async () => {
    await withTempRoot(async (root) => {
      const stale = join(root, "voice-stale");
      const fresh = join(root, "voice-fresh");
      const unrelated = join(root, "other-dir");
      await Promise.all([mkdir(stale), mkdir(fresh), mkdir(unrelated)]);
      const nowMs = Date.parse("2026-09-06T00:00:00.000Z");
      const staleDate = new Date(nowMs - 10_000);
      const freshDate = new Date(nowMs - 1_000);
      await utimes(stale, staleDate, staleDate);
      await utimes(fresh, freshDate, freshDate);
      await utimes(unrelated, staleDate, staleDate);

      expect(await reapStaleVoiceTempDirs(root, { nowMs, staleAfterMs: 5_000 })).toBe(1);
      expect(await pathExists(stale)).toBe(false);
      expect(await pathExists(fresh)).toBe(true);
      expect(await pathExists(unrelated)).toBe(true);
    });
  });
});
