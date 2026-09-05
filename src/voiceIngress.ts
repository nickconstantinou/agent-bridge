import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { InteractiveAttachment, InteractiveTurnInput } from "./interactiveIngress.js";

export const DEFAULT_VOICE_TEMP_ROOT = join(tmpdir(), "agent-bridge-voice");
export const DEFAULT_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_AUDIO_DURATION_SECONDS = 5 * 60;
export const DEFAULT_VOICE_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface VoiceTranscriber {
  readonly name: string;
  readonly available: boolean;
  transcribe(input: {
    filePath: string;
    mimeType?: string;
    signal: AbortSignal;
  }): Promise<{ text: string }>;
}

export interface VoiceAudioStager {
  stage(input: {
    attachment: InteractiveAttachment;
    operationDir: string;
    signal: AbortSignal;
  }): Promise<string>;
}

export type VoicePreparationResult =
  | { kind: "ready"; turn: InteractiveTurnInput }
  | { kind: "unavailable"; reason: string }
  | { kind: "cancelled" }
  | { kind: "failed"; error: Error };

export interface PrepareVoiceTurnOptions {
  transcriber: VoiceTranscriber;
  stager: VoiceAudioStager;
  signal: AbortSignal;
  tempRoot?: string;
  maxAudioBytes?: number;
  maxDurationSeconds?: number;
}

export const unavailableVoiceTranscriber: VoiceTranscriber = Object.freeze({
  name: "unavailable",
  available: false,
  async transcribe(): Promise<{ text: string }> {
    throw new Error("Voice-note transcription is not configured on this runtime.");
  },
});

export function isAudioAttachment(attachment: InteractiveAttachment): boolean {
  return attachment.kind === "audio";
}

export function hasAudioAttachment(turn: InteractiveTurnInput): boolean {
  return turn.attachments.some(isAudioAttachment);
}

function cancellationRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function createVoiceOperationDir(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const operationDir = await mkdtemp(join(root, "voice-"));
  await chmod(operationDir, 0o700);
  return operationDir;
}

function combineCaptionAndTranscript(caption: string, transcript: string): string {
  const cleanCaption = caption.trim();
  const cleanTranscript = transcript.trim();
  return cleanCaption
    ? `${cleanCaption}\n\n[Voice note transcript]\n${cleanTranscript}`
    : cleanTranscript;
}

/**
 * Prepare audio as one ordinary interactive text turn.
 * The caller owns the AbortController; production wiring will bind it to the
 * existing execution lifecycle once the droplet-qualified STT backend lands.
 */
export async function prepareVoiceTurn(
  turn: InteractiveTurnInput,
  options: PrepareVoiceTurnOptions,
): Promise<VoicePreparationResult> {
  const audio = turn.attachments.filter(isAudioAttachment);
  if (audio.length === 0) return { kind: "ready", turn };
  if (audio.length > 1) return { kind: "failed", error: new Error("Only one audio attachment is supported per turn.") };
  if (!options.transcriber.available) {
    return { kind: "unavailable", reason: "Voice-note transcription is not configured on this runtime." };
  }
  if (cancellationRequested(options.signal)) return { kind: "cancelled" };

  const attachment = audio[0];
  const maxAudioBytes = options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  const maxDurationSeconds = options.maxDurationSeconds ?? DEFAULT_MAX_AUDIO_DURATION_SECONDS;
  if (attachment.fileSize !== undefined && attachment.fileSize > maxAudioBytes) {
    return { kind: "failed", error: new Error(`Audio exceeds the ${maxAudioBytes}-byte processing limit.`) };
  }
  if (attachment.durationSeconds !== undefined && attachment.durationSeconds > maxDurationSeconds) {
    return { kind: "failed", error: new Error(`Audio exceeds the ${maxDurationSeconds}-second processing limit.`) };
  }

  let operationDir: string | null = null;
  try {
    operationDir = await createVoiceOperationDir(options.tempRoot ?? DEFAULT_VOICE_TEMP_ROOT);
    if (cancellationRequested(options.signal)) return { kind: "cancelled" };

    const filePath = await options.stager.stage({ attachment, operationDir, signal: options.signal });
    if (cancellationRequested(options.signal)) return { kind: "cancelled" };
    if (!isPathInside(operationDir, filePath)) throw new Error("Voice media stager returned a path outside its operation directory.");

    const staged = await lstat(filePath);
    if (staged.isSymbolicLink() || !staged.isFile()) throw new Error("Staged voice media is not a regular file.");
    if (staged.size > maxAudioBytes) throw new Error(`Audio exceeds the ${maxAudioBytes}-byte processing limit.`);

    const result = await options.transcriber.transcribe({
      filePath,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
      signal: options.signal,
    });

    // This is the pre-dispatch cancellation fence. A late STT completion after
    // cancellation cannot be converted into a provider Run by this seam.
    if (cancellationRequested(options.signal)) return { kind: "cancelled" };
    const transcript = result.text.trim();
    if (!transcript) throw new Error("Voice transcription returned no text.");

    return {
      kind: "ready",
      turn: {
        ...turn,
        text: combineCaptionAndTranscript(turn.text, transcript),
        attachments: turn.attachments.filter((item) => item !== attachment),
      },
    };
  } catch (error) {
    if (cancellationRequested(options.signal) || (error instanceof Error && error.name === "AbortError")) {
      return { kind: "cancelled" };
    }
    return { kind: "failed", error: asError(error) };
  } finally {
    if (operationDir) await rm(operationDir, { recursive: true, force: true });
  }
}

/** Remove only stale, direct, managed `voice-*` directories. Symlinks are never followed. */
export async function reapStaleVoiceTempDirs(
  root: string = DEFAULT_VOICE_TEMP_ROOT,
  options: { nowMs?: number; staleAfterMs?: number } = {},
): Promise<number> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_VOICE_STALE_AFTER_MS;
  let removed = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.startsWith("voice-") || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = join(root, entry.name);
    const info = await lstat(candidate).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    if (nowMs - info.mtimeMs < staleAfterMs) continue;
    await rm(candidate, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
