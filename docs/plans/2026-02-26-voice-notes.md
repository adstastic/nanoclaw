# Voice Note Transcription Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transcribe Signal voice notes on the host before they reach the agent, injecting `[Voice: "transcript"]` into message content.

**Architecture:** whisper.cpp runs in an Apple Container (port 2022) with a read-only model mount. `signal.ts` downloads `audio/*` attachments and calls `transcribeAudio()` in a new `src/transcription.ts` module. Agent always receives a text label — transcript or fallback. No agent changes required.

**Tech Stack:** whisper.cpp (C++, Metal GPU), Apple Container, Node.js native `fetch` + `FormData`

**Design doc:** `docs/plans/2026-02-26-voice-notes-design.md`

---

### Task 1: Config — add WHISPER_API_URL

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`

**Step 1: Add `WHISPER_API_URL` to the `readEnvFile` key list in `src/config.ts`**

In `src/config.ts`, add `'WHISPER_API_URL'` to the array passed to `readEnvFile` (same pattern as `SIGNAL_API_URL`). Then export the constant at the bottom of the file:

```ts
export const WHISPER_API_URL =
  process.env.WHISPER_API_URL || envConfig.WHISPER_API_URL || 'http://localhost:2022';
```

**Step 2: Add to `.env.example`**

Append under the Signal section:

```
# Whisper ASR (local speech-to-text for voice notes)
WHISPER_API_URL=http://localhost:2022
```

**Step 3: Build to verify**

```bash
npm run build
```
Expected: clean compile, no errors.

**Step 4: Commit**

```bash
git add src/config.ts .env.example
git commit -m "feat: add WHISPER_API_URL config"
```

---

### Task 2: `src/transcription.ts` (TDD)

**Files:**
- Create: `src/transcription.ts`
- Create: `src/transcription.test.ts`

**Step 1: Write the failing tests**

Create `src/transcription.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transcribeAudio } from './transcription.js';
import fs from 'node:fs';

vi.mock('node:fs');

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('transcribeAudio', () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue(Buffer.from('fake-audio'));
    mockFetch.mockReset();
  });

  it('returns transcript on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '  hello world  ' }),
    });
    const result = await transcribeAudio('/tmp/audio.ogg', 'http://localhost:2022');
    expect(result).toBe('hello world');
  });

  it('returns empty string when no speech detected', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '' }),
    });
    const result = await transcribeAudio('/tmp/audio.ogg', 'http://localhost:2022');
    expect(result).toBe('');
  });

  it('returns null when server returns non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const result = await transcribeAudio('/tmp/audio.ogg', 'http://localhost:2022');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await transcribeAudio('/tmp/audio.ogg', 'http://localhost:2022');
    expect(result).toBeNull();
  });
});
```

**Step 2: Run tests — verify they fail**

```bash
npx vitest run src/transcription.test.ts
```
Expected: FAIL — `Cannot find module './transcription.js'`

**Step 3: Implement `src/transcription.ts`**

```ts
import fs from 'node:fs';
import path from 'node:path';

/**
 * Transcribe an audio file by POSTing it to a whisper.cpp-compatible
 * /v1/audio/transcriptions endpoint.
 *
 * Returns the transcript string (may be empty if no speech detected),
 * or null on any error (server down, network failure, bad response).
 */
export async function transcribeAudio(
  filePath: string,
  apiUrl: string,
): Promise<string | null> {
  try {
    const audioBuffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);

    const form = new FormData();
    form.append('file', new Blob([audioBuffer]), filename);
    form.append('model', 'whisper-1');

    const res = await fetch(`${apiUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
    });

    if (!res.ok) return null;

    const data = await res.json() as { text?: string };
    return data.text?.trim() ?? null;
  } catch {
    return null;
  }
}
```

**Step 4: Run tests — verify they pass**

```bash
npx vitest run src/transcription.test.ts
```
Expected: 4 passing

**Step 5: Build**

```bash
npm run build
```
Expected: clean compile.

**Step 6: Commit**

```bash
git add src/transcription.ts src/transcription.test.ts
git commit -m "feat: transcribeAudio — POST audio to whisper.cpp, return transcript"
```

---

### Task 3: `signal.ts` — audio attachment handling (TDD)

**Files:**
- Modify: `src/channels/signal.ts`
- Modify: `src/channels/signal.test.ts`

**Context:** In `signal.ts`, the attachment loop is around line 298. Currently `isSupported` allows `image/*`, `application/pdf`, `text/*`. Audio hits the `!isSupported` warn branch. The goal is to add `audio/*` support with transcription instead of file labelling. Audio is NOT added to `downloadedAttachments` — the agent only needs the transcript text.

**Step 1: Find the existing audio test (if any) in `signal.test.ts`**

Search for `audio` in `signal.test.ts`. There should be a test asserting `[Audio]` placeholder for audio with no attachment id. That test is for the no-id branch (line ~332) and does not need to change. We're adding a new test for the has-id audio branch.

**Step 2: Write the failing tests**

Add a new `describe` block to `signal.test.ts`. Place it near the existing attachment tests. You'll need to mock `transcribeAudio` — add this mock near the top of the file alongside the other mocks:

```ts
vi.mock('../transcription.js', () => ({
  transcribeAudio: vi.fn(),
}));
```

Also add `WHISPER_API_URL: 'http://localhost:2022'` to the `vi.mock('../config.js', ...)` return object.

Then add the test block:

```ts
import { transcribeAudio } from '../transcription.js';

describe('audio attachment handling', () => {
  it('injects transcript into message content', async () => {
    vi.mocked(transcribeAudio).mockResolvedValueOnce('call me back please');
    // Send a WS message with an audio/ogg attachment that has an id
    // (reuse the existing helper pattern from the image attachment tests)
    // Assert message content is '[Voice: "call me back please"]'
    // Assert downloadedAttachments is empty (no audio file passed to agent)
  });

  it('uses unavailable fallback when transcription returns null', async () => {
    vi.mocked(transcribeAudio).mockResolvedValueOnce(null);
    // Assert content is '[Voice: transcription unavailable]'
  });

  it('uses no-speech fallback when transcript is empty string', async () => {
    vi.mocked(transcribeAudio).mockResolvedValueOnce('');
    // Assert content is '[Voice: (no speech detected)]'
  });
});
```

To fill in the test bodies, look at the existing image attachment test in `signal.test.ts` to understand how to send a fake WS message with an attachment and capture the resulting stored message. Mirror that pattern exactly, changing `contentType` to `audio/ogg`.

**Step 3: Run tests — verify they fail**

```bash
npx vitest run src/channels/signal.test.ts
```
Expected: 3 new failing tests.

**Step 4: Implement in `signal.ts`**

At the top of the file, add imports:
```ts
import { transcribeAudio } from '../transcription.js';
import { WHISPER_API_URL } from '../config.js';
```

In the attachment loop, change the `isSupported` check and add audio handling:

```ts
const isAudio = ctBase === 'audio';
const isSupported =
  ctBase === 'image' ||
  ct === 'application/pdf' ||
  ctBase === 'text' ||
  isAudio;

if (!isSupported) {
  logger.warn({ attachmentId: att.id, contentType: ct }, 'Skipping unsupported attachment type');
} else {
  const ext = extFromContentType(ct);
  const isImage = ctBase === 'image';
  const displayName = att.filename || (isImage ? `image-${i}.${ext}` : `attachment-${i}.${ext}`);
  const attachDir = path.join(STORE_DIR, 'attachments', msgId);
  const filePath = path.join(attachDir, `${i}.${ext}`);

  const ok = await this.downloadAttachment(att.id, filePath);

  if (isAudio) {
    const transcript = ok ? await transcribeAudio(filePath, WHISPER_API_URL) : null;
    let label: string;
    if (transcript === null) {
      label = '[Voice: transcription unavailable]';
    } else if (transcript === '') {
      label = '[Voice: (no speech detected)]';
    } else {
      label = `[Voice: "${transcript}"]`;
    }
    content = content ? `${content} ${label}` : label;
    // Don't push to downloadedAttachments — agent needs only the transcript
  } else {
    if (ok) {
      downloadedAttachments.push({ hostPath: filePath, contentType: ct, filename: displayName });
    }
    const label = isImage ? `[Image: ${displayName}]` : `[File: ${displayName}]`;
    content = content ? `${content} ${label}` : label;
  }
}
```

**Step 5: Run all tests**

```bash
npm test
```
Expected: all passing including the 3 new audio tests.

**Step 6: Commit**

```bash
git add src/channels/signal.ts src/channels/signal.test.ts
git commit -m "feat: transcribe audio/* attachments in signal.ts using whisper.cpp"
```

---

### Task 4: whisper.cpp container

**Files:**
- Create: `container/whisper/Dockerfile`

**Step 1: Create `container/whisper/Dockerfile`**

```dockerfile
# Stage 1: build whisper.cpp server from source
FROM ubuntu:24.04 AS builder

RUN apt-get update && apt-get install -y \
    build-essential cmake git libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp /whisper
WORKDIR /whisper
RUN cmake -B build \
    -DWHISPER_BUILD_SERVER=ON \
    -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j$(nproc) --target whisper-server

# Stage 2: minimal runtime image
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y libcurl4 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /whisper/build/bin/whisper-server /usr/local/bin/whisper-server

EXPOSE 2022

# Model is mounted at /models at runtime — not baked in
CMD ["whisper-server", \
     "--model", "/models/ggml-large-v3-turbo.bin", \
     "--host", "0.0.0.0", \
     "--port", "2022", \
     "--inference-path", "/v1/audio/transcriptions"]
```

**Step 2: Build the image**

```bash
container build -t nanoclaw-whisper:latest container/whisper/
```

This will take a few minutes (compiling whisper.cpp from source). Expected: `Successfully built nanoclaw-whisper:latest`

**Step 3: Download the model**

```bash
mkdir -p store/whisper-models
curl -L -o store/whisper-models/ggml-large-v3-turbo.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
```

File is ~1.5GB. Add to `.gitignore`:
```bash
echo 'store/whisper-models/' >> .gitignore
git add .gitignore
```

**Step 4: Smoke-test the container manually**

```bash
container run --rm -it \
  -p 2022:2022 \
  -v $(pwd)/store/whisper-models:/models:ro \
  nanoclaw-whisper:latest
```

In another terminal, test with a real audio file:
```bash
curl -s -X POST http://localhost:2022/v1/audio/transcriptions \
  -F "file=@/path/to/any/audio.ogg" \
  -F "model=whisper-1"
```
Expected: `{"text":"...transcript..."}` or similar JSON.

**Step 5: Create named container for LaunchAgent**

```bash
container run -d \
  --name whisper \
  -p 2022:2022 \
  -v $(pwd)/store/whisper-models:/models:ro \
  nanoclaw-whisper:latest
container stop whisper
```

This creates the named container so the LaunchAgent can use `container start whisper`.

**Step 6: Commit**

```bash
git add container/whisper/Dockerfile .gitignore
git commit -m "feat: add whisper.cpp container (Dockerfile + named container setup)"
```

---

### Task 5: LaunchAgent

**Files:**
- Create: `~/Library/LaunchAgents/com.nanoclaw.whisper.plist`

**Step 1: Create the plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.whisper</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/container</string>
        <string>start</string>
        <string>whisper</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <false/>

    <key>StandardOutPath</key>
    <string>/tmp/nanoclaw-whisper.log</string>

    <key>StandardErrorPath</key>
    <string>/tmp/nanoclaw-whisper.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/adi</string>
    </dict>
</dict>
</plist>
```

**Step 2: Load the LaunchAgent**

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.whisper.plist
```

**Step 3: Verify it started**

```bash
sleep 5 && tail -20 /tmp/nanoclaw-whisper.log
curl -s http://localhost:2022/v1/audio/transcriptions 2>&1
```
Expected: whisper-server startup logs, and the curl returns a 400/422 (wrong request format, but server is alive).

---

### Task 6: Build, deploy, end-to-end

**Step 1: Build host**

```bash
npm run build
```

**Step 2: Kill stale containers and restart NanoClaw**

```bash
container ls | grep nanoclaw | awk '{print $1}' | xargs -I{} container stop {} 2>/dev/null
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.agent
```

**Step 3: Send a voice note to yourself on Signal**

Check logs:
```bash
tail -f /tmp/nanoclaw.log | grep -i voice
```
Expected: agent receives `[Voice: "..."]` and responds to its content.

**Step 4: Test fallback — stop whisper and send another voice note**

```bash
container stop whisper
# send voice note
# verify message delivered as [Voice: transcription unavailable]
container start whisper
```

**Step 5: Final commit**

```bash
git add .
git commit -m "feat: voice note transcription — whisper.cpp container + LaunchAgent"
```
