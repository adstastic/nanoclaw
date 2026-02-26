# Voice Note Transcription — Design

## Overview

Automatically transcribe Signal voice notes before they reach the agent. The agent receives plain text (`[Voice: "..."]`) and needs no knowledge of ASR. Transcription is a deterministic host-side transformation, not an agent decision.

## Backend: whisper.cpp in Apple Container

**Why whisper.cpp:** Brew-installable, Metal GPU support, OpenAI-compatible `/v1/audio/transcriptions` endpoint, no Python stack. `large-v3-turbo` model gives best latency/accuracy on Apple Silicon.

**Why containerised:** whisper.cpp processes untrusted external input (audio from any Signal contact). C++ audio codec parsing has a history of memory corruption bugs. If exploited natively, attacker gets full user access (Obsidian vault, SSH keys, `.env`). Container limits blast radius to an empty sandbox with one read-only model mount.

**Why not Parakeet or WhisperKit:** Parakeet requires NeMo (heavy Python stack, no ready-made container). WhisperKit is Swift-only with no HTTP server. whisper.cpp is the simplest path to a general-purpose local ASR API usable beyond NanoClaw.

## Architecture

```
Signal voice note
  → signal.ts: download audio/* to store/attachments/
  → transcription.ts: POST bytes to whisper container :2022
  → whisper container: reads model from /models (read-only mount)
  → returns transcript string
  → message content = [Voice: "transcript text"]
  → agent receives as normal text
```

## Components

### `container/whisper/Dockerfile`
Builds whisper.cpp server from source. Model is NOT baked in — mounted at runtime. Container has no network access and no filesystem access beyond the model mount.

### `store/whisper-models/`
Host-side model storage (gitignored). Downloaded once:
```bash
whisper-cpp-download-ggml-model large-v3-turbo ~/.../store/whisper-models
```

### `~/Library/LaunchAgents/com.nanoclaw.whisper.plist`
Starts whisper container on login. Mounts `store/whisper-models/` read-only to `/models`. Exposes port 2022. Same pattern as `com.nanoclaw.signal-api.plist`.

### `src/transcription.ts`
```ts
export async function transcribeAudio(filePath: string, apiUrl: string): Promise<string | null>
```
POSTs audio file as multipart to `POST /v1/audio/transcriptions`. Returns transcript string or `null` on any failure. Stateless and testable in isolation.

### `src/channels/signal.ts` changes
- Add `audio/*` to `isSupported` content types
- After download, call `transcribeAudio(filePath, WHISPER_API_URL)`
- Set message content to one of:
  - `[Voice: "transcript"]` — success
  - `[Voice: transcription unavailable]` — whisper down or error
  - `[Voice: (no speech detected)]` — empty transcript

### `src/config.ts` + `.env.example`
`WHISPER_API_URL` defaulting to `http://localhost:2022`.

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| whisper container down | `[Voice: transcription unavailable]` — message still delivered |
| Audio download fails | Existing behaviour (unchanged) |
| Empty transcript | `[Voice: (no speech detected)]` |
| Timeout | `[Voice: transcription unavailable]` |

Agent always receives a message. No silent drops.

## Testing

- Unit tests for `transcribeAudio`: success, network failure, empty transcript, timeout
- Unit tests for audio branch in `signal.ts`: content injection, fallback strings
- No container integration tests (too heavy for CI)

## Out of Scope

- Streaming transcription (not needed for voice notes)
- Speaker diarisation
- Language detection / non-English support (large-v3-turbo handles both)
- WhatsApp audio (WhatsApp channel not in use)
