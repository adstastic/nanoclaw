import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  STORE_DIR: '/tmp/test-store',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: actual.readFileSync,
    },
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: actual.readFileSync,
  };
});

// --- WebSocket mock ---

type WSHandler = (event: any) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  listeners = new Map<string, WSHandler[]>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, handler: WSHandler) {
    const existing = this.listeners.get(event) || [];
    existing.push(handler);
    this.listeners.set(event, existing);
  }

  close() {
    this.closed = true;
  }

  // Test helper: simulate server event
  _emit(event: string, data?: any) {
    const handlers = this.listeners.get(event) || [];
    for (const h of handlers) h(data ?? {});
  }

  _emitOpen() {
    this._emit('open');
  }

  _emitMessage(data: any) {
    this._emit('message', { data: JSON.stringify(data) });
  }

  _emitClose() {
    this._emit('close');
  }

  _emitError(err?: any) {
    this._emit('error', err ?? new Error('ws error'));
  }
}

// Replace global WebSocket
const originalWebSocket = globalThis.WebSocket;
beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as any).WebSocket = MockWebSocket;
});
afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
});

// --- fetch mock ---

const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;
beforeEach(() => {
  (globalThis as any).fetch = mockFetch;
  mockFetch.mockReset();
});
afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

import fs from 'fs';
import { SignalChannel, SignalChannelOpts } from './signal.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SignalChannelOpts>,
): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'sig:+15559990000': {
        name: 'Personal DM',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      // groupId 'groupABC123' → base64 'Z3JvdXBBQkMxMjM=' → JID 'sig:group.Z3JvdXBBQkMxMjM='
      'sig:group.Z3JvdXBBQkMxMjM=': {
        name: 'Team Chat',
        folder: 'team',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function currentWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

/** Connect a channel, automatically resolving the WebSocket open */
async function connectChannel(
  channel: SignalChannel,
): Promise<MockWebSocket> {
  // Mock /v1/about as reachable
  mockFetch.mockResolvedValueOnce({ ok: true });

  const connectPromise = channel.connect();
  // The fetch is async so we need to flush the microtask queue
  // to allow the WebSocket constructor to be called
  await vi.advanceTimersByTimeAsync(0);

  const ws = currentWs();
  ws._emitOpen();
  await connectPromise;
  return ws;
}

function makeEnvelope(overrides: {
  source?: string;
  sourceName?: string;
  message?: string;
  timestamp?: number;
  groupId?: string;
  groupName?: string;
  attachments?: any[];
  quote?: { id: number; author: string; text: string };
  mentions?: { start: number; length: number; number: string; uuid?: string }[];
}) {
  const dataMessage: any = {
    timestamp: overrides.timestamp ?? Date.now(),
    message: overrides.message ?? null,
  };
  if (overrides.groupId) {
    dataMessage.groupInfo = {
      groupId: overrides.groupId,
      groupName: overrides.groupName || 'Group',
    };
  }
  if (overrides.attachments) {
    dataMessage.attachments = overrides.attachments;
  }
  if (overrides.quote) {
    dataMessage.quote = overrides.quote;
  }
  if (overrides.mentions) {
    dataMessage.mentions = overrides.mentions;
  }
  return {
    envelope: {
      source: overrides.source ?? '+15559990000',
      sourceName: overrides.sourceName ?? 'Alice',
      dataMessage,
    },
  };
}

function makeReactionEnvelope(overrides: {
  source?: string;
  sourceName?: string;
  emoji: string;
  targetAuthor: string;
  targetSentTimestamp: number;
  isRemove?: boolean;
}) {
  return {
    envelope: {
      source: overrides.source ?? '+15559990000',
      sourceName: overrides.sourceName ?? 'Alice',
      reactionMessage: {
        emoji: overrides.emoji,
        targetAuthor: overrides.targetAuthor,
        targetSentTimestamp: overrides.targetSentTimestamp,
        isRemove: overrides.isRemove ?? false,
      },
    },
  };
}

// --- Tests ---

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('verifies API is reachable before connecting WebSocket', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      mockFetch.mockResolvedValueOnce({ ok: true });
      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      currentWs()._emitOpen();
      await p;

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/about',
      );
    });

    it('throws if API is not reachable', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      await expect(channel.connect()).rejects.toThrow('Signal API not reachable');
    });

    it('connects WebSocket to correct URL', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      await connectChannel(channel);

      expect(currentWs().url).toBe(
        'ws://localhost:8080/v1/receive/+15551234567',
      );
    });

    it('converts https to wss for WebSocket URL', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'https://signal.example.com',
        '+15551234567',
        opts,
      );

      await connectChannel(channel);

      expect(currentWs().url).toBe(
        'wss://signal.example.com/v1/receive/+15551234567',
      );
    });

    it('isConnected() is true after connect', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      await connectChannel(channel);

      expect(channel.isConnected()).toBe(true);
    });

    it('isConnected() is false before connect', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      expect(channel.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      const ws = await connectChannel(channel);

      await channel.disconnect();

      expect(ws.closed).toBe(true);
      expect(channel.isConnected()).toBe(false);
    });

    it('auto-reconnects on WebSocket close', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      const ws1 = await connectChannel(channel);
      ws1._emitClose();

      expect(channel.isConnected()).toBe(false);

      // Advance past reconnect delay (5s) — openWebSocket() will be called
      await vi.advanceTimersByTimeAsync(5000);

      // A new WebSocket should have been created
      expect(MockWebSocket.instances.length).toBe(2);

      // Complete the reconnection so it doesn't hang
      currentWs()._emitOpen();
      await vi.advanceTimersByTimeAsync(0);

      expect(channel.isConnected()).toBe(true);
    });

    it('does not reconnect after explicit disconnect', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      await connectChannel(channel);
      await channel.disconnect();

      await vi.advanceTimersByTimeAsync(10000);

      // Only the initial WebSocket should exist
      expect(MockWebSocket.instances.length).toBe(1);
    });
  });

  // --- DM message handling ---

  describe('DM message handling', () => {
    it('delivers DM for registered chat', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      const ts = 1704067200000; // 2024-01-01T00:00:00.000Z
      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          sourceName: 'Alice',
          message: 'Hello',
          timestamp: ts,
        }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sig:+15559990000',
        '2024-01-01T00:00:00.000Z',
        'Alice',
        'signal',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({
          id: `${ts}-+15559990000`,
          chat_jid: 'sig:+15559990000',
          sender: '+15559990000',
          sender_name: 'Alice',
          content: 'Hello',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered DMs', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15550000001',
          sourceName: 'Unknown',
          message: 'Hey',
        }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses sender phone as name when sourceName is missing', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      const envelope = makeEnvelope({
        source: '+15559990000',
        message: 'Hi',
      });
      envelope.envelope.sourceName = undefined as any;
      ws._emitMessage(envelope);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ sender_name: '+15559990000' }),
      );
    });
  });

  // --- Group message handling ---

  describe('group message handling', () => {
    it('delivers group message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          sourceName: 'Alice',
          message: 'Group hello',
          groupId: 'groupABC123',
          groupName: 'Team Chat',
        }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sig:group.Z3JvdXBBQkMxMjM=',
        expect.any(String),
        'Team Chat',
        'signal',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:group.Z3JvdXBBQkMxMjM=',
        expect.objectContaining({
          chat_jid: 'sig:group.Z3JvdXBBQkMxMjM=',
          sender: '+15559990000',
          content: 'Group hello',
        }),
      );
    });

    it('only emits metadata for unregistered groups', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: 'Test',
          groupId: 'unknownGroup',
          groupName: 'Random',
        }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Self-message filtering ---

  describe('self-message filtering', () => {
    it('ignores messages from own phone number', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15551234567', // same as channel's phone number
          message: 'My own message',
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });
  });

  // --- Commands ---

  describe('commands', () => {
    it('!chatid replies with DM chat ID', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      // Mock the send response
      mockFetch.mockResolvedValueOnce({ ok: true });

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          sourceName: 'Alice',
          message: '!chatid',
        }),
      );

      // Should have called sendMessage (fetch POST to /v2/send)
      // Allow async send to complete
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v2/send',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('sig:+15559990000'),
        }),
      );

      // Should NOT deliver as a regular message
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('!chatid replies with group chat ID', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '!chatid',
          groupId: 'groupABC123',
          groupName: 'Team Chat',
        }),
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v2/send',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('sig:group.Z3JvdXBBQkMxMjM='),
        }),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('!ping replies with online status', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '!ping',
        }),
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v2/send',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Andy is online'),
        }),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Media placeholders ---

  describe('media placeholders', () => {
    it('maps image attachment to [Photo]', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '',
          attachments: [{ contentType: 'image/jpeg' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('maps video attachment to [Video]', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '',
          attachments: [{ contentType: 'video/mp4' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('maps audio attachment to [Audio]', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '',
          attachments: [{ contentType: 'audio/ogg' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('maps unknown attachment to [Attachment]', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '',
          attachments: [{ contentType: 'application/pdf' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ content: '[Attachment]' }),
      );
    });

    it('appends attachment placeholder to text message', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: 'Look at this',
          attachments: [{ contentType: 'image/png' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ content: 'Look at this [Photo]' }),
      );
    });

    it('reassembles long messages from text/x-signal-plain attachment', async () => {
      const fullText = 'A'.repeat(3000); // Longer than Signal's ~2000 char body limit
      const truncatedBody = fullText.slice(0, 2000);

      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      // Mock fetch for the long-message attachment download (after connect)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => fullText,
      });

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: truncatedBody,
          attachments: [{ contentType: 'text/x-signal-plain', id: 'long-msg-123' }],
        }),
      );
      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ content: fullText }),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/attachments/long-msg-123',
      );
    });

    it('falls back to truncated body when long-message download fails', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      // Mock fetch failure for the attachment download (after connect)
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: 'Truncated body',
          attachments: [{ contentType: 'text/x-signal-plain', id: 'fail-123' }],
        }),
      );
      await vi.waitFor(() => expect(opts.onMessage).toHaveBeenCalled());

      // Should still deliver the truncated body, not append [Attachment]
      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ content: 'Truncated body' }),
      );
    });

    it('ignores messages with no text and no attachments', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '',
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

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
  });

  // --- Non-image attachment download ---

  describe('non-image attachment download', () => {
    beforeEach(() => {
      vi.mocked(fs.mkdirSync).mockClear();
      vi.mocked(fs.writeFileSync).mockClear();
    });

    it('downloads a PDF attachment and includes it in message attachments', async () => {
      const pdfBytes = Buffer.from('%PDF-1.4 fake content');

      const opts = createTestOpts();
      const channel = new SignalChannel('http://localhost:8080', '+15551234567', opts);
      const ws = await connectChannel(channel);

      // Set up attachment fetch mock AFTER connectChannel (which consumed the /v1/about mock)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => pdfBytes.buffer,
      });

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
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
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

      const opts = createTestOpts();
      const channel = new SignalChannel('http://localhost:8080', '+15551234567', opts);
      const ws = await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => zipBytes.buffer,
      });

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
      expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    });

    it('gracefully delivers message when attachment download fails', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('http://localhost:8080', '+15551234567', opts);
      const ws = await connectChannel(channel);

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

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

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends DM with recipients array', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await channel.sendMessage('sig:+15559990000', 'Hello');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v2/send',
        expect.objectContaining({ method: 'POST' }),
      );

      const body = JSON.parse(
        (mockFetch.mock.calls.find(
          (c: any) => c[0] === 'http://localhost:8080/v2/send',
        ) as any)[1].body,
      );
      expect(body.recipients).toEqual(['+15559990000']);
      expect(body.number).toBe('+15551234567');
      expect(body.message).toBe('Hello');
    });

    it('sends group message with recipients array', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await channel.sendMessage('sig:group.Z3JvdXBBQkMxMjM=', 'Group msg');

      const sendCall = mockFetch.mock.calls.find(
        (c: any) => c[0] === 'http://localhost:8080/v2/send',
      ) as any;
      const body = JSON.parse(sendCall[1].body);
      expect(body.recipients).toEqual(['group.Z3JvdXBBQkMxMjM=']);
      expect(body.message).toBe('Group msg');
    });

    it('splits messages exceeding 4000 characters', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true });

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('sig:+15559990000', longText);

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any) => c[0] === 'http://localhost:8080/v2/send',
      );
      expect(sendCalls.length).toBe(2);

      const body1 = JSON.parse((sendCalls[0] as any)[1].body);
      const body2 = JSON.parse((sendCalls[1] as any)[1].body);
      expect(body1.message.length).toBe(4000);
      expect(body2.message.length).toBe(1000);
    });

    it('sends exactly one message at 4000 characters', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });

      await channel.sendMessage('sig:+15559990000', 'y'.repeat(4000));

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any) => c[0] === 'http://localhost:8080/v2/send',
      );
      expect(sendCalls.length).toBe(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        channel.sendMessage('sig:+15559990000', 'Will fail'),
      ).resolves.toBeUndefined();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends PUT for typing start on DM', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await channel.setTyping('sig:+15559990000', true);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/typing-indicator/+15551234567',
        expect.objectContaining({ method: 'PUT' }),
      );

      const typingCall = mockFetch.mock.calls.find(
        (c: any) =>
          typeof c[0] === 'string' && c[0].includes('typing-indicator'),
      ) as any;
      const body = JSON.parse(typingCall[1].body);
      expect(body.recipient).toBe('+15559990000');
    });

    it('sends DELETE for typing stop', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await channel.setTyping('sig:+15559990000', false);

      const typingCall = mockFetch.mock.calls.find(
        (c: any) =>
          typeof c[0] === 'string' && c[0].includes('typing-indicator'),
      ) as any;
      expect(typingCall[1].method).toBe('DELETE');
    });

    it('sends group typing indicator with group field', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await channel.setTyping('sig:group.Z3JvdXBBQkMxMjM=', true);

      const typingCall = mockFetch.mock.calls.find(
        (c: any) =>
          typeof c[0] === 'string' && c[0].includes('typing-indicator'),
      ) as any;
      const body = JSON.parse(typingCall[1].body);
      expect(body.group).toBe('groupABC123');
      expect(body.recipient).toBeUndefined();
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockRejectedValueOnce(new Error('Rate limited'));

      await expect(
        channel.setTyping('sig:+15559990000', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns sig: JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        createTestOpts(),
      );
      expect(channel.ownsJid('sig:+15559990000')).toBe(true);
    });

    it('owns sig: group JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        createTestOpts(),
      );
      expect(channel.ownsJid('sig:group.Z3JvdXBBQkMxMjM=')).toBe(true);
    });

    it('does not own tg: JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        createTestOpts(),
      );
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        createTestOpts(),
      );
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "signal"', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        createTestOpts(),
      );
      expect(channel.name).toBe('signal');
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('ignores envelopes with no dataMessage', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage({ envelope: { source: '+15559990000' } });

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores envelopes with no source', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage({
        envelope: { dataMessage: { timestamp: Date.now(), message: 'Hi' } },
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores malformed JSON', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      // Send raw non-JSON string
      ws._emit('message', { data: 'not-json' });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('strips trailing slash from API URL', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080/',
        '+15551234567',
        opts,
      );

      await connectChannel(channel);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/about',
      );
    });
  });

  // --- Quoted messages ---

  describe('quoted messages', () => {
    it('prepends quote context to message content', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          sourceName: 'Alice',
          message: 'What about this?',
          quote: {
            id: 1771853168333,
            author: '+15550001111',
            text: 'Original message text',
          },
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({
          content: '[Replying to +15550001111: "Original message text"]\nWhat about this?',
          is_reply_to_bot: false,
        }),
      );
    });

    it('sets is_reply_to_bot when quoting bot message', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567', // bot's phone number
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          sourceName: 'Alice',
          message: 'Tell me more',
          quote: {
            id: 1771853168333,
            author: '+15551234567', // bot's number
            text: 'Here is the info you asked for',
          },
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({
          content: '[Replying to Andy: "Here is the info you asked for"]\nTell me more',
          is_reply_to_bot: true,
        }),
      );
    });

    it('does not set is_reply_to_bot when quoting non-bot message', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: 'Interesting',
          quote: {
            id: 1771853168333,
            author: '+15550009999',
            text: 'Something else said',
          },
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({
          is_reply_to_bot: false,
        }),
      );
    });

    it('truncates quoted text longer than 200 chars', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      const longText = 'x'.repeat(250);
      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: 'Reply',
          quote: {
            id: 1771853168333,
            author: '+15550001111',
            text: longText,
          },
        }),
      );

      const call = (opts.onMessage as any).mock.calls[0];
      const content = call[1].content as string;
      expect(content).toContain('x'.repeat(200) + '...');
      expect(content).not.toContain('x'.repeat(201));
    });

    it('handles quote with no text gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: 'Replying to something',
          quote: {
            id: 1771853168333,
            author: '+15551234567',
            text: '',
          },
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({
          content: 'Replying to something',
          is_reply_to_bot: true,
        }),
      );
    });
  });

  // --- Emoji reactions ---

  describe('emoji reactions', () => {
    it('stores reaction as [Reacted emoji] message', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeReactionEnvelope({
          source: '+15559990000',
          sourceName: 'Alice',
          emoji: '👍',
          targetAuthor: '+15550009999',
          targetSentTimestamp: 1771853168333,
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({
          content: '[Reacted 👍]',
          sender: '+15559990000',
          sender_name: 'Alice',
        }),
      );
    });

    it('ignores reaction removals', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeReactionEnvelope({
          source: '+15559990000',
          emoji: '👍',
          targetAuthor: '+15551234567',
          targetSentTimestamp: 1771853168333,
          isRemove: true,
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('does not set is_reply_to_bot for reactions', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeReactionEnvelope({
          source: '+15559990000',
          emoji: '✅',
          targetAuthor: '+15551234567', // reaction to bot's message
          targetSentTimestamp: 1771853168333,
        }),
      );

      const call = (opts.onMessage as any).mock.calls[0];
      expect(call[1].is_reply_to_bot).toBeFalsy();
    });
  });

  // --- @mentions ---

  describe('@mentions', () => {
    it('replaces mention placeholder with bot name and sets is_reply_to_bot', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          sourceName: 'Alice',
          message: '\uFFFC test',
          mentions: [
            { start: 0, length: 1, number: '+15551234567', uuid: 'bot-uuid' },
          ],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({
          content: '@Andy test',
          is_reply_to_bot: true,
        }),
      );
    });

    it('replaces non-bot mention with phone number', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          sourceName: 'Alice',
          message: '\uFFFC check this',
          mentions: [
            { start: 0, length: 1, number: '+15550009999' },
          ],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({
          content: '@+15550009999 check this',
          is_reply_to_bot: false,
        }),
      );
    });

    it('handles multiple mentions in one message', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '\uFFFC and \uFFFC what do you think?',
          mentions: [
            { start: 0, length: 1, number: '+15550009999' },
            { start: 6, length: 1, number: '+15551234567' },
          ],
        }),
      );

      const call = (opts.onMessage as any).mock.calls[0];
      expect(call[1].content).toBe('@+15550009999 and @Andy what do you think?');
      expect(call[1].is_reply_to_bot).toBe(true);
    });
  });

  // --- sendReaction ---

  describe('sendReaction', () => {
    it('sends reaction via POST to /v1/reactions/{number}', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await channel.sendReaction(
        'sig:+15559990000',
        '✅',
        1771853168333,
        '+15559990000',
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/reactions/+15551234567',
        expect.objectContaining({ method: 'POST' }),
      );

      const reactionCall = mockFetch.mock.calls.find(
        (c: any) => typeof c[0] === 'string' && c[0].includes('/v1/reactions/'),
      ) as any;
      const body = JSON.parse(reactionCall[1].body);
      expect(body.reaction).toBe('✅');
      expect(body.target_author).toBe('+15559990000');
      expect(body.timestamp).toBe(1771853168333);
      expect(body.recipient).toBe('+15559990000');
    });

    it('handles reaction send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        channel.sendReaction('sig:+15559990000', '👍', 12345, '+15559990000'),
      ).resolves.toBeUndefined();
    });
  });
});
