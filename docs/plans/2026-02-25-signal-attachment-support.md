# Signal Attachment Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Download and surface non-image Signal attachments (PDFs, text files, arbitrary files) to the agent so it can read them via Claude's native content blocks or Bash/Read tools.

**Architecture:** Three-tier routing by content type — images already work; PDFs/text become native Claude API content blocks; everything else is saved to disk and the container path is injected into message text. File paths on disk always use a numeric index (`{i}.{ext}`), never the sender-supplied filename.

**Tech Stack:** TypeScript, Node.js, vitest (tests), Claude Agent SDK (`document` content block type for PDFs)

---

### Task 1: Extend `extFromContentType()` in signal.ts and add tests

**Files:**
- Modify: `src/channels/signal.ts:18-24`
- Test: `src/channels/signal.test.ts`

**Step 1: Write the failing test**

Add a new `describe('extFromContentType via attachment download')` block inside the existing `describe('SignalChannel')`. The function is private, so we test it indirectly by checking the filename suffix in the saved path that gets passed to `onMessage` — but for now just test that `application/pdf` attachments without an `id` still show the current `[Attachment]` placeholder (to confirm the test infra works before we change behavior):

> **Note on the test file's config mock:** `src/channels/signal.test.ts` currently mocks `../config.js` with only `ASSISTANT_NAME` and `TRIGGER_PATTERN`. Add `STORE_DIR: '/tmp/test-store'` to that mock — it's needed once we start downloading files.

Open `src/channels/signal.test.ts` and update the config mock at the top:

```typescript
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  STORE_DIR: '/tmp/test-store',
}));
```

Then add this test inside `describe('media placeholders')`:

```typescript
it('shows [Attachment] placeholder for pdf without id (no download attempted)', async () => {
  const opts = createTestOpts();
  const channel = new SignalChannel('http://localhost:8080', '+15551234567', opts);
  const ws = await connectChannel(channel);

  ws._emitMessage(
    makeEnvelope({
      source: '+15559990000',
      message: 'See attached',
      attachments: [{ contentType: 'application/pdf' }], // no id
    }),
  );
  await vi.advanceTimersByTimeAsync(0);

  expect(opts.onMessage).toHaveBeenCalledWith(
    'sig:+15559990000',
    expect.objectContaining({ content: 'See attached [Attachment]' }),
  );
});
```

**Step 2: Run test to verify it passes (baseline)**

```bash
npm test -- --reporter=verbose src/channels/signal.test.ts
```

Expected: PASS (current behavior already handles this case).

**Step 3: Extend `extFromContentType()` in signal.ts**

Add document types to the map in `src/channels/signal.ts:19-23`:

```typescript
function extFromContentType(ct: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'text/markdown': 'md',
  };
  return map[ct] || 'bin';
}
```

**Step 4: Run tests to verify still passing**

```bash
npm test -- --reporter=verbose src/channels/signal.test.ts
```

Expected: All existing tests PASS.

**Step 5: Commit**

```bash
git add src/channels/signal.ts src/channels/signal.test.ts
git commit -m "feat: extend extFromContentType for pdf and text types"
```

---

### Task 2: Download non-image attachments in signal.ts

**Files:**
- Modify: `src/channels/signal.ts:265-319`
- Test: `src/channels/signal.test.ts`

**Background:** The current `else` branch (lines 300–318) shows a placeholder for everything that isn't an image or `text/x-signal-plain`. We need to split it: if `att.id` exists, download the file; otherwise keep the placeholder.

The variable `imageAttachments` currently holds only images — rename it to `downloadedAttachments` (it will now hold all downloaded files).

**Step 1: Write failing tests**

Add a new `describe('non-image attachment download')` block. These tests need `fs` spied on to prevent actual disk writes.

Add this import at the top of the test file (after existing imports):

```typescript
import * as fs from 'fs';
```

Then add the test block inside `describe('SignalChannel')`:

```typescript
describe('non-image attachment download', () => {
  let mkdirSyncSpy: ReturnType<typeof vi.spyOn>;
  let writeFileSyncSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mkdirSyncSpy.mockRestore();
    writeFileSyncSpy.mockRestore();
  });

  it('downloads a PDF attachment and includes it in message attachments', async () => {
    const pdfBytes = Buffer.from('%PDF-1.4 fake content');
    mockFetch
      .mockResolvedValueOnce({ ok: true }) // /v1/about (connect)
      .mockResolvedValueOnce({             // /v1/attachments/pdf-123
        ok: true,
        arrayBuffer: async () => pdfBytes.buffer,
      });

    const opts = createTestOpts();
    const channel = new SignalChannel('http://localhost:8080', '+15551234567', opts);
    const ws = await connectChannel(channel);

    const ts = 1704067200000;
    ws._emitMessage(
      makeEnvelope({
        source: '+15559990000',
        timestamp: ts,
        message: 'Check this out',
        attachments: [{ contentType: 'application/pdf', id: 'pdf-123', filename: 'report.pdf' }],
      }),
    );
    await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());

    // Fetch called for the attachment
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:8080/v1/attachments/pdf-123');

    // File written to correct path (index-based, not att.filename)
    const msgId = `${ts}-+15559990000`;
    expect(writeFileSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining(`attachments/${msgId}/0.pdf`),
      expect.any(Buffer),
    );

    // onMessage called with attachment metadata and display hint in content
    expect(opts.onMessage).toHaveBeenCalledWith(
      'sig:+15559990000',
      expect.objectContaining({
        content: expect.stringContaining('[File: report.pdf]'),
        attachments: expect.arrayContaining([
          expect.objectContaining({ contentType: 'application/pdf' }),
        ]),
      }),
    );
  });

  it('downloads an unknown-type attachment and includes path hint in content', async () => {
    const zipBytes = Buffer.from('PK fake zip');
    mockFetch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => zipBytes.buffer,
      });

    const opts = createTestOpts();
    const channel = new SignalChannel('http://localhost:8080', '+15551234567', opts);
    const ws = await connectChannel(channel);

    ws._emitMessage(
      makeEnvelope({
        source: '+15559990000',
        message: '',
        attachments: [{ contentType: 'application/zip', id: 'zip-456', filename: 'archive.zip' }],
      }),
    );
    await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sig:+15559990000',
      expect.objectContaining({
        content: expect.stringContaining('[File: archive.zip]'),
        attachments: expect.arrayContaining([
          expect.objectContaining({ contentType: 'application/zip' }),
        ]),
      }),
    );
  });

  it('shows [Attachment] placeholder when no id (no download)', async () => {
    const opts = createTestOpts();
    const channel = new SignalChannel('http://localhost:8080', '+15551234567', opts);
    const ws = await connectChannel(channel);

    ws._emitMessage(
      makeEnvelope({
        source: '+15559990000',
        message: 'Hi',
        attachments: [{ contentType: 'application/pdf' }], // no id
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(opts.onMessage).toHaveBeenCalledWith(
      'sig:+15559990000',
      expect.objectContaining({ content: 'Hi [Attachment]' }),
    );
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('gracefully delivers message when attachment download fails', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('Network error'));

    const opts = createTestOpts();
    const channel = new SignalChannel('http://localhost:8080', '+15551234567', opts);
    const ws = await connectChannel(channel);

    ws._emitMessage(
      makeEnvelope({
        source: '+15559990000',
        message: 'See attached',
        attachments: [{ contentType: 'application/pdf', id: 'fail-pdf' }],
      }),
    );
    await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());

    // Message still delivered, no attachment in the array
    expect(opts.onMessage).toHaveBeenCalledWith(
      'sig:+15559990000',
      expect.objectContaining({
        content: expect.stringContaining('See attached'),
        attachments: undefined,
      }),
    );
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm test -- --reporter=verbose src/channels/signal.test.ts
```

Expected: 3 new tests FAIL (download never happens, attachment not in message).

**Step 3: Implement in signal.ts**

Replace the `else` block in the attachment loop (lines 300–318) and rename `imageAttachments` to `downloadedAttachments`.

Full replacement for the attachment loop section (lines 265–319):

```typescript
// Build content from text + attachments
let content = messageText;
const rawAttachments: any[] = dataMessage.attachments || [];
const downloadedAttachments: Attachment[] = [];

for (let i = 0; i < rawAttachments.length; i++) {
  const att = rawAttachments[i];
  const ct: string = att.contentType || '';

  // Signal sends long messages (>2000 chars) as a text/x-signal-plain attachment
  if (ct === 'text/x-signal-plain' && att.id) {
    try {
      const res = await fetch(`${this.apiUrl}/v1/attachments/${att.id}`);
      if (res.ok) {
        const fullText = await res.text();
        if (fullText.length > content.length) {
          content = fullText;
          logger.debug({ attachmentId: att.id, length: fullText.length }, 'Long message attachment reassembled');
        }
      }
    } catch (err) {
      logger.warn({ attachmentId: att.id, err }, 'Failed to download long-message attachment');
    }
  } else if (IMAGE_CONTENT_TYPES.has(ct) && att.id) {
    const ext = extFromContentType(ct);
    const filename = att.filename || `image-${i}.${ext}`;
    const attachDir = path.join(STORE_DIR, 'attachments', msgId);
    const filePath = path.join(attachDir, `${i}.${ext}`);

    const ok = await this.downloadAttachment(att.id, filePath);
    if (ok) {
      downloadedAttachments.push({ hostPath: filePath, contentType: ct, filename });
    }
    content = content ? `${content} [Image: ${filename}]` : `[Image: ${filename}]`;
  } else if (att.id) {
    // Non-image, non-text attachment — download and surface path to agent
    const ext = extFromContentType(ct);
    const displayName = att.filename || `attachment-${i}.${ext}`;
    const attachDir = path.join(STORE_DIR, 'attachments', msgId);
    const filePath = path.join(attachDir, `${i}.${ext}`);

    const ok = await this.downloadAttachment(att.id, filePath);
    if (ok) {
      downloadedAttachments.push({ hostPath: filePath, contentType: ct, filename: displayName });
    }
    content = content ? `${content} [File: ${displayName}]` : `[File: ${displayName}]`;
  } else {
    // No id — can't download, show a type-appropriate placeholder
    const type = ct.split('/')[0];
    let placeholder: string;
    switch (type) {
      case 'image': placeholder = '[Photo]'; break;
      case 'video': placeholder = '[Video]'; break;
      case 'audio': placeholder = '[Audio]'; break;
      default: placeholder = '[Attachment]'; break;
    }
    content = content ? `${content} ${placeholder}` : placeholder;
  }
}
```

Also update the `onMessage` call at line 352 to use `downloadedAttachments`:

```typescript
attachments: downloadedAttachments.length > 0 ? downloadedAttachments : undefined,
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- --reporter=verbose src/channels/signal.test.ts
```

Expected: All tests PASS including the 4 new ones.

**Step 5: Commit**

```bash
git add src/channels/signal.ts src/channels/signal.test.ts
git commit -m "feat: download non-image Signal attachments (pdf, docs, arbitrary files)"
```

---

### Task 3: Extend `CONTENT_TYPE_FROM_EXT` in container-runner.ts

**Files:**
- Modify: `src/container-runner.ts:629-632`
- Test: `src/container-runner.test.ts`

**Background:** `prepareAttachmentsForContainer()` re-derives content type from file extension. Since Task 2 now saves PDFs as `0.pdf`, the map needs `pdf → application/pdf` to pass the right content type into the container.

**Step 1: Write the failing test**

Add this to `src/container-runner.test.ts` (find a good place after the existing tests, or add a new describe block):

```typescript
import { prepareAttachmentsForContainer } from './container-runner.js';
import fs from 'fs';
```

> Note: `fs` is already fully mocked in `container-runner.test.ts`. You'll need to configure the mock returns for this test.

Add:

```typescript
describe('prepareAttachmentsForContainer', () => {
  it('maps pdf extension to application/pdf content type', () => {
    const mockFs = vi.mocked(fs);
    // Simulate store/attachments/msg-001/ containing 0.pdf
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['0.pdf'] as any);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.copyFileSync.mockReturnValue(undefined);

    const result = prepareAttachmentsForContainer(['msg-001'], 'main');

    expect(result).toEqual([
      {
        containerPath: '/workspace/ipc/attachments/msg-001/0.pdf',
        contentType: 'application/pdf',
      },
    ]);
  });

  it('maps txt extension to text/plain content type', () => {
    const mockFs = vi.mocked(fs);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['0.txt'] as any);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.copyFileSync.mockReturnValue(undefined);

    const result = prepareAttachmentsForContainer(['msg-002'], 'main');

    expect(result).toEqual([
      {
        containerPath: '/workspace/ipc/attachments/msg-002/0.txt',
        contentType: 'text/plain',
      },
    ]);
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    const mockFs = vi.mocked(fs);
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readdirSync.mockReturnValue(['0.bin'] as any);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.copyFileSync.mockReturnValue(undefined);

    const result = prepareAttachmentsForContainer(['msg-003'], 'main');

    expect(result[0].contentType).toBe('application/octet-stream');
  });
});
```

**Step 2: Run tests to verify pdf test fails**

```bash
npm test -- --reporter=verbose src/container-runner.test.ts
```

Expected: The pdf test FAILS (maps to `application/octet-stream` instead of `application/pdf`).

**Step 3: Extend the map in container-runner.ts**

Replace lines 629–632:

```typescript
const CONTENT_TYPE_FROM_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
};
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- --reporter=verbose src/container-runner.test.ts
```

Expected: All tests PASS.

**Step 5: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat: map pdf/txt/csv/md extensions to correct content types in container runner"
```

---

### Task 4: Extend `buildContentBlocks()` in agent-runner for PDF and text

**Files:**
- Modify: `container/agent-runner/src/index.ts:22-27` (type definitions), `container/agent-runner/src/index.ts:305-325` (function body)

No unit test file exists for the agent-runner (it runs in a container). TypeScript compilation serves as the compile-time check; a manual smoke test verifies runtime behavior.

**Step 1: Add `DocumentContentBlock` type**

Replace the type block at lines 22–27:

```typescript
type TextContentBlock = { type: 'text'; text: string };
type ImageContentBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
};
type DocumentContentBlock = {
  type: 'document';
  source: { type: 'base64'; media_type: string; data: string };
};
type ContentBlock = TextContentBlock | ImageContentBlock | DocumentContentBlock;
```

**Step 2: Replace `buildContentBlocks()` body**

Replace lines 305–325:

```typescript
/**
 * Build content block array for Claude's API.
 * - image/* → image block (vision)
 * - application/pdf → document block (native PDF reading)
 * - text/* → text block (UTF-8 content inlined)
 * - else → text note with container path for Bash/Read tool use
 */
function buildContentBlocks(
  text: string,
  attachments: { containerPath: string; contentType: string }[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text }];
  for (const att of attachments) {
    const ct = att.contentType;
    try {
      if (ct.startsWith('image/')) {
        const data = fs.readFileSync(att.containerPath, 'base64');
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: ct, data },
        });
      } else if (ct === 'application/pdf') {
        const data = fs.readFileSync(att.containerPath, 'base64');
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data },
        });
      } else if (ct.startsWith('text/')) {
        const fileText = fs.readFileSync(att.containerPath, 'utf-8');
        const header = `[File: ${path.basename(att.containerPath)}]\n`;
        blocks.push({ type: 'text', text: header + fileText });
      } else {
        // Binary file — agent uses Bash/Read tools to process it
        blocks.push({
          type: 'text',
          text: `[Attached file: ${att.containerPath} (${ct}) — use Bash or Read tools to process]`,
        });
      }
    } catch (err) {
      log(`Failed to read attachment ${att.containerPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return blocks;
}
```

**Step 3: Verify TypeScript compiles**

```bash
npm run build
```

Expected: Exits 0 with no TypeScript errors.

**Step 4: Rebuild the container image**

```bash
./container/build.sh
```

Expected: Build succeeds.

**Step 5: Smoke test — send a PDF via Signal**

Send a PDF file to the registered Signal DM. Watch the logs:

```bash
tail -f /tmp/nanoclaw.log
```

Expected log lines:
- `attachment downloaded` — file saved to `store/attachments/`
- `Signal message stored` — message delivered with attachments
- Container spawned, agent output includes summary of the PDF content

**Step 6: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: route pdf/text attachments as document/text content blocks in agent runner"
```

---

### Task 5: Run full test suite and verify

**Step 1: Run all tests**

```bash
npm test
```

Expected: All tests PASS with no failures.

**Step 2: Restart the service**

```bash
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw.agent
```

**Step 3: Commit (if any final fixups needed)**

```bash
git add -p
git commit -m "fix: <description of any fixups>"
```
