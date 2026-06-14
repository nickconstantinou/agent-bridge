# Local-First Voice Subsystem — Technical Architecture & Implementation Blueprint

**Status:** Research / Pre-implementation  
**Scope:** TTS (kokoro-js / ONNX), STT (whisper.cpp), Discord voice transport (@discordjs/voice + DAVE)  
**Constraint:** Zero paid APIs; zero cloud audio processing

---

## Executive Summary

This is a high-risk, high-effort integration. The individual components (Kokoro, whisper.cpp, @discordjs/voice) all work in isolation. The problem is the seams between them:

- **DAVE (Discord's E2E voice encryption)** is the single biggest blocker for inbound voice. As of mid-2025, @discordjs/voice's DAVE support is partial and known to produce `DecryptionFailed` errors on incoming streams. Receiving voice from Discord channels reliably requires either waiting for upstream fixes or pulling in native MLS bindings (`@snazzah/davey`) that are not production-hardened for this stack.
- **The Node.js event loop is not designed for real-time audio**. ONNX inference (TTS) and whisper.cpp decoding (STT) both block the JS thread when called synchronously. A 20ms Opus frame window is unforgiving. Any >5ms main-thread stall causes audible dropout. This is solvable with `worker_threads` but requires careful IPC design.
- **Outbound TTS (text-in, voice-out) is the safe path.** The kokoro-js + @discordjs/voice pipeline is well-mapped, carries no decryption complexity, and can be isolated in a worker thread. Phase A (text prompts, spoken replies) is achievable in 2–4 weeks. Phase B (full duplex) is a 6–12 week effort with significant dependency risk.

**Recommendation:** Ship Phase A first. It delivers immediate value (agent speaks replies in voice channels) without touching DAVE. Defer Phase B until @discordjs/voice's DAVE path stabilises or `@snazzah/davey` reaches a stable 1.x release.

---

## Architectural Diagram

```
INBOUND VOICE (Phase B only — DAVE-blocked)
────────────────────────────────────────────────────────────────────────────

  Discord Network
       │  Encrypted Opus frames (DAVE / MLS)
       ▼
  @discordjs/voice VoiceReceiver
       │  (DecryptionFailed risk — see §2.1)
       ▼
  @snazzah/davey (NAPI-RS / OpenMLS)  ← native C++ binding
       │  Raw Opus frames (20ms)
       ▼
  Opus decoder (opusscript or native)
       │  PCM Float32 @ 48kHz
       ▼
  VAD ring buffer (webrtc-vad or silero-vad)
       │  speech segment (flush on silence >500ms)
       ▼
  [worker_thread: whisper.cpp via @kutalia/whisper-node-addon]
       │  transcript text
       ▼
  Main thread — handleMessage() → engine dispatch


OUTBOUND TTS (Phase A — safe path)
────────────────────────────────────────────────────────────────────────────

  CLI engine → text response
       │
       ▼
  [worker_thread: kokoro-js + ONNX Runtime (q8)]
       │  Float32 PCM @ 24kHz
       ▼
  Resample 24kHz → 48kHz  (audiobuffer-resample or sox via spawn)
       │  Float32 PCM @ 48kHz
       ▼
  PCM → Opus encode  (@discordjs/voice OpusEncoder)
       │  Opus frames (20ms, 48kHz stereo or mono)
       ▼
  AudioPlayer (createAudioPlayer + createAudioResource)
       │
       ▼
  Discord Network → Voice Channel
```

---

## Component Breakdown

### TTS

| Property | Value |
|---|---|
| Library | `kokoro-js` ^1.x (transformers.js + onnxruntime-node) |
| Model | `kokoro-v1.0-q8` (~80MB on disk) |
| Quantisation | int8 / q8 — ~50% memory reduction vs fp32 |
| Resident memory | ~160–220MB per worker (ONNX Runtime heap + model) |
| Inference time | 0.8–2.5s per ~100 words on a modern CPU (no GPU) |
| Output format | Float32 PCM array @ 24kHz, mono |
| Blocking? | Yes — inference is synchronous on the calling thread |
| Thread placement | Dedicated `worker_thread`; main thread posts text via `MessageChannel` |
| CPU cost | 1–4 cores at 100% during inference; idles between calls |

### STT

| Property | Value |
|---|---|
| Library | `@kutalia/whisper-node-addon` (NAPI native binding to whisper.cpp) |
| Model | `ggml-base.en.bin` (141MB) or `ggml-tiny.en.bin` (75MB) |
| Input format | Float32 PCM @ 16kHz, mono (must downsample from 48kHz) |
| Inference time | 0.3–1.5s for a 5-second audio segment (base.en, no GPU) |
| Blocking? | Yes — NAPI addon executes synchronously unless explicit async path used |
| Thread placement | Dedicated `worker_thread`; receives PCM buffers via `SharedArrayBuffer` or `transferList` |
| Resident memory | ~250–400MB (model + ONNX beam search buffers) |
| VAD | Required to gate inference — transcribing silence wastes cycles |

### Transport

| Property | Value |
|---|---|
| Library | `@discordjs/voice` ^0.17.x |
| Outbound | `createAudioPlayer()` + `createAudioResource()` + Opus encoder — stable |
| Inbound DAVE | Partial; `DecryptionFailed` errors reported in v0.17.x on MLS key rotation |
| Opus encoder | `@discordjs/opus` (native) or `opusscript` (wasm fallback) |
| Frame budget | 20ms per Opus frame (50 frames/s) — hard real-time constraint |
| Reconnect on voice disconnect | Must handle `VoiceConnectionStatus.Disconnected` with explicit re-join |
| Dependency weight | `@discordjs/voice` + opus + sodium/libsodium-wrappers: ~35MB install |

---

## Section 1: Outbound Audio Pipeline (TTS)

### 1.1 Engine Selection — kokoro-js + ONNX q8

`kokoro-js` loads the Kokoro v1.0 model via `@huggingface/transformers` (transformers.js), which dispatches to `onnxruntime-node` in a Node.js process. The q8 (int8 quantised) variant trades ~1–3% quality for ~50% memory reduction versus fp32 — the right tradeoff for a server that will also be running SQLite and CLI processes.

Critical installation note: `onnxruntime-node` ships a prebuilt native binding. Ensure the `onnxruntime-node` version pinned in `package.json` has a prebuilt for the server's Node.js version and arch (`linux/x64`). If there is no prebuilt, the install will fail silently at runtime with a dlopen error. Pin to `onnxruntime-node@1.19.x` which has broad prebuilt coverage.

The model must be pre-downloaded and cached locally; kokoro-js will attempt an HuggingFace Hub fetch on first load if the local cache is empty. Set `HF_HUB_OFFLINE=1` in the service env once the model is cached to prevent runtime HTTP calls.

### 1.2 Integration Blueprint

```
CLI engine finishes → result.text (string)
         │
         ▼
  [main thread] detectShouldSpeak(channelId)  ← per-channel voice opt-in flag in SQLite
         │
         ├── false → normal text sendMessage()
         │
         └── true  → postToTtsWorker(text, channelId)
                                │
                                ▼
                  [worker_thread: tts-worker.ts]
                  const kokoro = await KokoroTTS.from_pretrained(
                    "onnx-community/Kokoro-82M-v1.0",
                    { dtype: "q8", device: "cpu" }
                  );
                  const audio = await kokoro.generate(text, { voice: "af_heart" });
                  // audio.audio is a Float32Array at 24kHz
                                │
                                ▼
                  resample(audio.audio, 24000, 48000)
                  // Returns Float32Array at 48kHz
                                │
                                ▼
                  float32ToInt16(pcm48k)
                  // @discordjs/voice's OpusEncoder expects Int16 PCM
                                │
                  postMessage({ type: "pcm", buffer: int16.buffer }, [int16.buffer])
                                │
                                ▼
         [main thread] receives PCM buffer
                  → createAudioResourceFromPCM(buffer)
                  → audioPlayer.play(resource)
```

### 1.3 PCM Conversion Layer — Code Sketch

```typescript
// tts-worker.ts (runs in worker_thread)
import { KokoroTTS } from "kokoro-js";
import { parentPort } from "node:worker_threads";

const kokoro = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0", {
  dtype: "q8",
  device: "cpu",
});

parentPort!.on("message", async ({ text, id }: { text: string; id: string }) => {
  const result = await kokoro.generate(text, { voice: "af_heart" });
  // result.audio: Float32Array @ 24kHz
  const pcm48k = resample(result.audio, 24_000, 48_000);
  const int16 = float32ToInt16(pcm48k);
  // Transfer the underlying ArrayBuffer — zero-copy across threads
  parentPort!.postMessage({ type: "pcm", id, buffer: int16.buffer }, [int16.buffer]);
});

function resample(input: Float32Array, fromHz: number, toHz: number): Float32Array {
  const ratio = toHz / fromHz;
  const out = new Float32Array(Math.ceil(input.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i / ratio;
    const lo = Math.floor(src);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = src - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

function float32ToInt16(f32: Float32Array): Int16Array {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = clamped * 32_767;
  }
  return i16;
}
```

```typescript
// voice-player.ts (main thread)
import { createAudioPlayer, createAudioResource, StreamType } from "@discordjs/voice";
import { Readable } from "node:stream";

export function playPcm(connection: VoiceConnection, int16Buffer: ArrayBuffer): void {
  const pcmStream = Readable.from(Buffer.from(int16Buffer));
  const resource = createAudioResource(pcmStream, {
    inputType: StreamType.Raw, // tells @discordjs/voice this is raw signed 16-bit PCM
    inlineVolume: false,
  });
  const player = createAudioPlayer();
  connection.subscribe(player);
  player.play(resource);
}
```

`StreamType.Raw` requires `@discordjs/voice` to know the sample rate and channel count. As of v0.17, those are fixed at 48kHz/2ch/16-bit for `StreamType.Raw`. The int16 buffer must therefore be stereo-interleaved (duplicate mono samples) or the output will be pitched wrong.

---

## Section 2: Inbound Audio Pipeline (STT) & The DAVE Wall

### 2.1 The Encryption Constraint

Discord's DAVE protocol (Discord Audio Video Encryption) was progressively rolled out from late 2023. It layers MLS (Message Layer Security, RFC 9420) over the existing SRTP voice transport. Every participant in a voice channel must complete an MLS key exchange before their audio frames can be decrypted by others.

**The problem with @discordjs/voice:**

@discordjs/voice was originally built for SRTP-only voice. DAVE adds:
1. A pre-voice MLS handshake over the WebSocket gateway
2. Per-frame header extensions carrying the sender's MLS epoch and key ID
3. Per-frame AEAD decryption before the Opus payload is accessible

@discordjs/voice v0.17 added partial DAVE support but the implementation has known failure modes:
- `DecryptionFailed` errors when MLS epoch rotates (e.g., after a member joins/leaves mid-session)
- Incoming frame `Buffer` corruption when the DAVE header extension length is non-standard
- No graceful fallback: when decryption fails, frames are silently dropped rather than reported

The library does not expose the raw encrypted frame buffer to userland, so there is no way to intercept and re-decrypt in pure JS without forking the library or using native bindings.

**What does not work:**
- Listening to `VoiceReceiver.subscribe(userId)` and receiving a clean Opus stream — this will produce partial/corrupt data when DAVE epoch rotation occurs.
- Disabling DAVE — it is mandatory for all non-bot-only voice channels. Bot-only private stage channels may still use legacy SRTP.

### 2.2 Pathway Evaluation

**Phase A — Text-In, Voice-Out (Recommended first target)**

- Bot joins the voice channel, waits silently.
- Users type commands in the text channel or use Discord slash commands.
- Bot speaks the CLI response using kokoro-js TTS.
- Zero inbound audio processing. Zero DAVE decryption. Zero whisper.cpp dependency.
- Latency: 1–3 seconds from CLI response to first audio.
- Risk: None beyond normal @discordjs/voice connection management.

**Phase B — Full Duplex (Future, high risk)**

Requires one of:

**Option B1 — @snazzah/davey (NAPI-RS / OpenMLS)**
- Native Node.js addon wrapping an OpenMLS Rust implementation.
- Performs the MLS epoch join/leave key exchange and decrypts incoming frames.
- As of 2025, `@snazzah/davey` is pre-1.0; its API surface has changed across minor versions.
- Must be compiled for the target arch. No prebuilt binaries in npm as of writing.
- Integration point: patch `@discordjs/voice` or intercept the UDP socket directly to pass raw frames through davey before the library's own decryption path.

**Option B2 — Fork @discordjs/voice**
- Expose the raw encrypted payload from the internal `VoiceUDPSocket`.
- Implement DAVE decryption in JS using WebCrypto (AES-GCM for the AEAD layer).
- Avoid Rust/NAPI dependency.
- High maintenance burden. Each @discordjs/voice update requires re-integration.

**Recommendation:** Do not start Phase B until @discordjs/voice's upstream DAVE handling is stable or @snazzah/davey ships a 1.0 with prebuilt binaries.

### 2.3 Local Transcriber — whisper.cpp Integration

Model selection:
- `ggml-tiny.en.bin` (75MB): fastest, ~3x real-time on CPU. Accuracy ~88% WER on clean speech.
- `ggml-base.en.bin` (141MB): balanced, ~1.5x real-time on CPU. Accuracy ~94% WER.
- `ggml-small.en.bin` (244MB): too slow for real-time on a CPU-only server; adds >2s latency per 5s segment.

**Recommended:** `ggml-base.en` for the primary server; `ggml-tiny.en` if memory is constrained.

**VAD Buffer Flush Logic:**

The core problem: whisper.cpp needs a complete speech segment, not a raw stream. You cannot feed it 20ms Opus frames one-by-one — inference setup cost alone exceeds 20ms.

```
Opus frames (20ms each, 48kHz stereo)
       │
       ▼  decode Opus → PCM @ 48kHz
       │
       ▼  downsample 48kHz → 16kHz (whisper requires 16kHz mono)
       │
       ▼  VAD ring buffer (rolling 30-frame / 600ms window)
            ├── SPEECH: append frame to segment buffer
            └── SILENCE: if segment_buffer.duration > 500ms
                         → flush segment_buffer to whisper worker
                         → clear segment_buffer
```

VAD options:
- `webrtc-vad` (npm): thin WASM wrapper around the WebRTC VAD C library. Works synchronously. Reliable on clean speech, struggles with background noise.
- `silero-vad` (ONNX model): higher accuracy, adds ~40MB RAM, runs in a worker_thread alongside whisper.

The VAD must run on the main thread (or a lightweight dedicated thread) to keep the frame buffer from filling up. Whisper inference must run in a separate `worker_thread` — it will block for 0.3–1.5s per segment.

---

## Section 3: Threading & Resource Contention

### 3.1 Event Loop Analysis

Node.js has a single JS event loop. Blocking it for >5ms causes audible stuttering in the voice channel because @discordjs/voice's `AudioPlayer` needs to schedule Opus frames every 20ms via `setInterval`.

**Contention sources in this stack:**

| Operation | Blocking? | Duration | Consequence |
|---|---|---|---|
| `better-sqlite3` queries | Yes (synchronous) | 0.1–5ms | Acceptable; keep transactions short |
| `better-sqlite3` WAL checkpoint | Yes (synchronous) | 5–50ms | Can drop audio frames; schedule checkpoints when player is idle |
| `onnxruntime-node` inference (TTS) | Yes (synchronous) | 800ms–2500ms | **Critical blocker** — must be in worker_thread |
| whisper.cpp NAPI decode | Yes (synchronous by default) | 300ms–1500ms | **Critical blocker** — must be in worker_thread |
| VAD computation (webrtc-vad WASM) | Micro-blocking | ~0.5ms per frame | Acceptable on main thread |
| Opus decode (for incoming audio) | Micro-blocking | ~0.2ms per frame | Acceptable on main thread |

### 3.2 Thread Boundary Design

```
Main Thread
├── @discordjs/voice AudioPlayer (frame scheduling — must never be blocked)
├── Gateway WebSocket handling (discord-gateway.ts)
├── BridgeEngine routing (engine.ts)
├── better-sqlite3 synchronous queries (short reads/writes only)
├── VAD per-frame computation (~0.5ms, acceptable)
├── Opus decode for incoming frames (~0.2ms, acceptable)
└── IPC coordinators for worker threads

Worker Thread A — TTS (1 instance, persistent)
└── kokoro-js + ONNX Runtime (full model resident in this thread's heap)
    Input:  text string (via MessageChannel)
    Output: Int16Array PCM @ 48kHz stereo (transferred via Transferable)
    Startup cost: 2–5s (model load); keep thread alive across requests

Worker Thread B — STT (1 instance, persistent)
└── @kutalia/whisper-node-addon (whisper.cpp)
    Input:  Float32Array PCM @ 16kHz (via Transferable or SharedArrayBuffer)
    Output: transcript string (via MessageChannel)
    Startup cost: 1–2s (model mmap); keep thread alive across requests

Worker Thread C — VAD (optional, only if silero-vad chosen)
└── silero-vad ONNX model (30MB)
    Input:  PCM frames via SharedArrayBuffer ring buffer
    Output: boolean speech/silence flag via Atomics.notify
```

**Why `Transferable` over `SharedArrayBuffer` for TTS output:** The PCM buffer is large (a 5-second response at 48kHz stereo int16 = ~960KB). Transferring ownership via `postMessage(buf, [buf])` avoids copying. The AudioPlayer reads it once and discards it.

**Why `SharedArrayBuffer` + `Atomics` for VAD:** VAD needs to process every 20ms Opus frame with minimal latency overhead. SharedArrayBuffer lets the main thread write frames and the VAD thread read them without IPC round-trip overhead.

**SQLite WAL checkpoint scheduling:**

```typescript
// Schedule checkpoints when the AudioPlayer is idle to avoid audio dropout
audioPlayer.on(AudioPlayerStatus.Idle, () => {
  db.raw.pragma("wal_checkpoint(PASSIVE)");
});
```

---

## Phased Implementation Roadmap

### Phase A — Text-In, Voice-Out (2–4 weeks, low risk)

**Goal:** Agent joins a Discord voice channel and speaks its CLI responses.

1. Add `@discordjs/voice` and `@discordjs/opus` to agent-bridge.
2. Add a `/voice join` slash command that joins the caller's current voice channel.
3. Implement `tts-worker.ts` with kokoro-js q8 in a `worker_thread`.
4. Wire the TTS worker into the post-execution path in `index-discord-interactive.ts`.
5. Add per-channel voice opt-in flag to `bridge_state` SQLite table.
6. Handle `VoiceConnectionStatus.Disconnected` with auto-rejoin.
7. Add `/voice leave` command.

**What Phase A does not include:**
- Inbound voice processing (no STT, no DAVE)
- Wake word detection
- Interrupt handling (user speaking while bot is speaking)

**Acceptance criteria:**
- Bot joins and stays joined across gateway reconnects.
- CLI responses are spoken within 3 seconds of text delivery.
- Voice channel disconnect triggers clean resource cleanup (no leaked AudioPlayers).

### Phase B — Full Duplex, Defensive (4–8 weeks, medium risk)

**Goal:** Bot can hear voice input and transcribe it, without DAVE decryption.

This phase is only viable if one of:
- @discordjs/voice upstream ships reliable DAVE decryption
- A private voice channel with only the bot user (skipping MLS negotiation) is acceptable

1. Integrate `@kutalia/whisper-node-addon` with `ggml-base.en.bin`.
2. Implement `stt-worker.ts` in a `worker_thread`.
3. Implement VAD ring buffer with `webrtc-vad`.
4. Accept voice only from a bot-only stage or a channel with DAVE disabled (if available).
5. Wire transcripts into `handleMessage()` path.

### Phase C — Full Duplex, DAVE-Native (6–12 weeks, high risk)

**Goal:** Bot decrypts and transcribes voice from any Discord voice channel, including DAVE-protected channels.

1. Evaluate `@snazzah/davey` stability at the time of development.
2. If pre-1.0: patch @discordjs/voice's internal UDP socket handler to pass raw frames through davey before the library's own decrypt path.
3. Implement per-session MLS epoch tracking in SQLite.
4. Full integration: voice in → VAD → whisper → BridgeEngine → kokoro TTS → voice out.

**Known risks at Phase C:**
- @snazzah/davey API instability between minor versions.
- Native compilation required on the deployment server (`node-gyp`, Rust toolchain).
- MLS epoch rotation on member join/leave may still produce occasional decrypt failures requiring frame-skip logic.
- Each @discordjs/voice update potentially breaks the UDP socket intercept layer.

---

## Dependency Checklist

```bash
# Phase A
npm install @discordjs/voice @discordjs/opus kokoro-js onnxruntime-node

# Pre-download kokoro model (do once; set HF_HUB_OFFLINE=1 after)
node -e "require('kokoro-js').KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0', { dtype: 'q8' })"

# Phase B additions
npm install @kutalia/whisper-node-addon webrtc-vad

# Download whisper model
wget -O models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

# Phase C additions (evaluate stability first)
npm install @snazzah/davey
```

---

## Open Questions Before Phase A

1. **Voice channel auto-join on startup?** Or explicit `/voice join` only? Auto-join risks the bot speaking in a channel nobody asked for.
2. **Voice opt-in granularity:** per-channel (current proposal) or per-user? Per-user adds SQLite schema complexity.
3. **TTS voice selection:** Kokoro ships 11 voices. Exposing a `/voice set-voice <name>` command is low effort and high value.
4. **Interrupt handling:** if the user sends a new message while the bot is mid-speech, should the bot stop speaking? Requires `audioPlayer.stop()` on new message receipt.
5. **Discord voice server region:** the bot's voice connection uses the guild's configured voice server region, not the gateway region. High latency to the voice server (~100ms+) will not affect TTS quality but will delay the first frame delivery.
