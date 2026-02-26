# Signal Attachment Support Design

**Date:** 2026-02-25
**Status:** Approved

## Problem

Signal messages with non-image attachments (PDFs, documents, archives, etc.) are currently silently dropped as `[Attachment]` placeholder text. The agent never sees the file content.

## Goal

Enable the agent to process any attachment that Claude Code can handle — images inline, PDFs as native document blocks, everything else saved to disk with path in message text.

## Approach

Three-tier routing based on content type:

| Tier | Types | Handling |
|------|-------|----------|
| Image | `image/*` | Already working — `image` content block passed to Claude API |
| Document | `application/pdf`, `text/*` | Download → copy to container IPC → `document` / `text` content block |
| Other | Everything else | Download → copy to container IPC → `[File: /workspace/ipc/attachments/{msgId}/{filename}]` in message text |

## Data Flow

```
Signal message with attachment
  → signal.ts: download to store/attachments/{msgId}/{i}.{ext}
  → storeMessage(): NewMessage.attachments = [{hostPath, contentType, filename}]
  → prepareAttachmentsForContainer(): copy to ipc/attachments/{msgId}/{i}.{ext},
                                      returns [{containerPath, contentType}]
  → ContainerInput.attachments passed via stdin to container
  → agent-runner: buildContentBlocks() routes by contentType:
      image/*         → { type: 'image', source: { type: 'base64', ... } }
      application/pdf → { type: 'document', source: { type: 'base64', media_type: 'application/pdf', ... } }
      text/*          → { type: 'text', text: <file contents> }
      else            → { type: 'text', text: '[Attached file: {path} ({contentType}) — use Bash/Read tools]' }
```

## Changes Required

### 1. `src/channels/signal.ts`

Extend the attachment loop to handle non-image types:

- Keep `text/x-signal-plain` handling (long messages) unchanged
- Keep image handling unchanged
- **New:** For all other types with an `att.id`, download to `store/attachments/{msgId}/`
- Use `{i}.{ext}` as the filename (derived from content type, not `att.filename`) — security requirement
- Append `[File: {att.filename || 'attachment'}]` to message content as display hint
- Pass downloaded files as `Attachment` objects (same as images)

Extend `extFromContentType()` and add a reverse lookup for common doc types:
```
application/pdf → pdf
text/plain      → txt
text/csv        → csv
text/markdown   → md
```

### 2. `src/container-runner.ts`

Extend `CONTENT_TYPE_FROM_EXT` map:
```
pdf → application/pdf
txt → text/plain
csv → text/csv
md  → text/markdown
```

Thread original `contentType` through: `prepareAttachmentsForContainer()` currently re-derives content type by extension. Since we now save files with extension derived from content type, this round-trips correctly — no structural change needed.

### 3. `container/agent-runner/src/index.ts`

Add `DocumentContentBlock` type:
```typescript
type DocumentContentBlock = {
  type: 'document';
  source: { type: 'base64'; media_type: string; data: string };
};
```

Extend `buildContentBlocks()` to route by content type:
```typescript
if (ct.startsWith('image/'))       → image block
if (ct === 'application/pdf')      → document block
if (ct.startsWith('text/'))        → text block (read as UTF-8)
else                               → text note with container path
```

IPC piped messages already support attachments — no changes needed there.

## Security Notes

- **Filename safety:** Always use `{i}.{ext}` for disk paths; `att.filename` is display-only
- **No executable routing:** Shell scripts, binaries etc. fall into the "other" tier — agent sees the path but must decide to use it
- **Content type trust:** We trust Signal's `contentType` for tier routing; spoofing it is harmless since Claude API treats document blocks as data, not executable content

## Out of Scope

- Voice/audio transcription (separate feature, Whisper skill exists)
- Video attachments
- Sending attachments back to the user (outbound file support)
