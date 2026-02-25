import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, STORE_DIR, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Attachment,
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const IMAGE_CONTENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
]);

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

function contentTypeFromExt(ext: string): string {
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private apiUrl: string;
  private phoneNumber: string;
  private opts: SignalChannelOpts;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private shouldReconnect = true;
  private replyTargets = new Map<string, { timestamp: number; author: string }>();

  constructor(apiUrl: string, phoneNumber: string, opts: SignalChannelOpts) {
    this.apiUrl = apiUrl.replace(/\/$/, ''); // strip trailing slash
    this.phoneNumber = phoneNumber;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Verify API is reachable
    const aboutUrl = `${this.apiUrl}/v1/about`;
    try {
      const res = await fetch(aboutUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      logger.info('Signal API reachable');
    } catch (err) {
      logger.error({ err, url: aboutUrl }, 'Signal API not reachable');
      throw new Error(`Signal API not reachable at ${aboutUrl}`);
    }

    this.shouldReconnect = true;
    await this.openWebSocket();
  }

  private openWebSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsHost = this.apiUrl.replace(/^http/, 'ws');
      const wsUrl = `${wsHost}/v1/receive/${this.phoneNumber}`;

      let resolved = false;

      this.ws = new WebSocket(wsUrl);

      this.ws.addEventListener('open', () => {
        this.connected = true;
        logger.info({ url: wsUrl }, 'Signal WebSocket connected');
        console.log(`\n  Signal channel: ${this.phoneNumber}`);
        console.log(`  Send !chatid in a Signal chat to get the registration ID\n`);
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      this.ws.addEventListener('message', async (event) => {
        try {
          const data = typeof event.data === 'string' ? event.data : String(event.data);
          logger.debug({ raw: data.slice(0, 500) }, 'Signal WS raw message');
          await this.handleMessage(JSON.parse(data));
        } catch (err) {
          logger.error({ err }, 'Failed to parse Signal WebSocket message');
        }
      });

      this.ws.addEventListener('close', () => {
        this.connected = false;
        logger.warn('Signal WebSocket closed');
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
        if (!resolved) {
          resolved = true;
          reject(new Error('Signal WebSocket closed before open'));
        }
      });

      this.ws.addEventListener('error', (err) => {
        logger.error({ err }, 'Signal WebSocket error');
        if (!resolved) {
          resolved = true;
          reject(new Error('Signal WebSocket error'));
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;
      logger.info('Reconnecting Signal WebSocket...');
      try {
        await this.openWebSocket();
      } catch {
        logger.warn('Signal reconnect failed, will retry');
        this.scheduleReconnect();
      }
    }, 5000);
  }

  private async handleMessage(envelope: any): Promise<void> {
    // signal-cli-rest-api JSON-RPC format
    const msg = envelope?.envelope;
    if (!msg) return;

    const sender = msg.source;
    if (!sender) return;

    // Filter self-messages
    if (sender === this.phoneNumber) return;

    const senderName = msg.sourceName || sender;

    // --- Handle emoji reactions ---
    const reaction = msg.reactionMessage;
    if (reaction) {
      if (reaction.isRemove) return; // Ignore reaction removals

      // Reactions don't carry groupInfo directly — use targetAuthor to route
      // We need a chat JID. Reactions in groups arrive with a groupInfo on the envelope.
      const groupInfo = msg.dataMessage?.groupInfo;
      const isGroup = !!groupInfo;
      let chatJid: string;
      let chatName: string;

      if (isGroup) {
        const stableGroupId = `group.${Buffer.from(groupInfo.groupId).toString('base64')}`;
        chatJid = `sig:${stableGroupId}`;
        chatName = groupInfo.groupName || chatJid;
      } else {
        chatJid = `sig:${sender}`;
        chatName = senderName;
      }

      const timestamp = new Date(reaction.targetSentTimestamp || Date.now()).toISOString();
      const content = `[Reacted ${reaction.emoji}]`;

      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'signal', isGroup);

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid, chatName }, 'Reaction from unregistered Signal chat');
        return;
      }

      const msgId = `reaction-${reaction.targetSentTimestamp}-${sender}`;

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, emoji: reaction.emoji },
        'Signal reaction stored',
      );
      return;
    }

    // --- Handle regular messages ---
    const dataMessage = msg.dataMessage;
    if (!dataMessage) return;

    const timestamp = new Date(dataMessage.timestamp).toISOString();

    // Determine chat JID
    const groupInfo = dataMessage.groupInfo;
    const isGroup = !!groupInfo;
    let chatJid: string;
    let chatName: string;

    if (isGroup) {
      // signal-cli gives groupId as raw base64. The API's stable ID is group. + base64(groupId).
      const stableGroupId = `group.${Buffer.from(groupInfo.groupId).toString('base64')}`;
      chatJid = `sig:${stableGroupId}`;
      chatName = groupInfo.groupName || chatJid;
    } else {
      chatJid = `sig:${sender}`;
      chatName = senderName;
    }

    // Parse quoted message
    let isReplyToBot = false;
    const quote = dataMessage.quote;
    if (quote) {
      isReplyToBot = quote.author === this.phoneNumber;
      if (quote.text) {
        const quotedName = quote.author === this.phoneNumber
          ? ASSISTANT_NAME
          : quote.author;
        const truncated = quote.text.length > 200
          ? quote.text.slice(0, 200) + '...'
          : quote.text;
        const quoteLine = `[Replying to ${quotedName}: "${truncated}"]`;
        // Prepend quote context — will be joined with message content below
        dataMessage._quotePrefix = quoteLine;
      }
    }

    // Handle @mentions — Signal uses \uFFFC placeholder chars in message text
    const mentions: any[] = dataMessage.mentions || [];
    let messageText = dataMessage.message || '';
    if (mentions.length > 0) {
      // Process mentions in reverse order to preserve string positions
      const sorted = [...mentions].sort((a, b) => b.start - a.start);
      for (const mention of sorted) {
        const isBotMention = mention.number === this.phoneNumber;
        if (isBotMention) isReplyToBot = true;
        const name = isBotMention ? `@${ASSISTANT_NAME}` : `@${mention.number}`;
        messageText =
          messageText.slice(0, mention.start) +
          name +
          messageText.slice(mention.start + mention.length);
      }
    }

    // Compute message ID early (needed for attachment paths)
    const msgId = `${dataMessage.timestamp}-${sender}`;

    // Build content from text + attachments
    let content = messageText;
    const rawAttachments: any[] = dataMessage.attachments || [];
    const downloadedAttachments: Attachment[] = [];

    for (let i = 0; i < rawAttachments.length; i++) {
      const att = rawAttachments[i];
      const ct: string = att.contentType || '';

      // Signal sends long messages (>2000 chars) as a text/x-signal-plain attachment
      // containing the full text — the body is truncated. Download and use the full text.
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
          case 'image':
            placeholder = '[Photo]';
            break;
          case 'video':
            placeholder = '[Video]';
            break;
          case 'audio':
            placeholder = '[Audio]';
            break;
          default:
            placeholder = '[Attachment]';
            break;
        }
        content = content ? `${content} ${placeholder}` : placeholder;
      }
    }

    // Prepend quote context if present
    if (dataMessage._quotePrefix) {
      content = content
        ? `${dataMessage._quotePrefix}\n${content}`
        : dataMessage._quotePrefix;
    }

    if (!content) return;

    // Handle commands
    const trimmed = content.trim();
    if (trimmed === '!chatid') {
      const typeLabel = isGroup ? 'group' : 'DM';
      this.sendCommandReply(chatJid, `Chat ID: ${chatJid}\nName: ${chatName}\nType: ${typeLabel}`);
      return;
    }
    if (trimmed === '!ping') {
      this.sendCommandReply(chatJid, `${ASSISTANT_NAME} is online.`);
      return;
    }

    // Store chat metadata for discovery
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'signal', isGroup);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid, chatName }, 'Message from unregistered Signal chat');
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_reply_to_bot: isReplyToBot,
      attachments: downloadedAttachments.length > 0 ? downloadedAttachments : undefined,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Signal message stored',
    );
  }

  private async sendCommandReply(chatJid: string, text: string): Promise<void> {
    try {
      await this.sendMessage(chatJid, text);
    } catch (err) {
      logger.error({ chatJid, err }, 'Failed to send Signal command reply');
    }
  }

  private async downloadAttachment(attachmentId: string, destPath: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/v1/attachments/${attachmentId}`);
      if (!res.ok) {
        logger.error({ attachmentId, status: res.status }, 'Failed to download Signal attachment');
        return false;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, buffer);
      logger.debug({ attachmentId, destPath, size: buffer.length }, 'Attachment downloaded');
      return true;
    } catch (err) {
      logger.error({ attachmentId, err }, 'Error downloading Signal attachment');
      return false;
    }
  }

  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    try {
      const imageData = fs.readFileSync(imagePath);
      const base64 = imageData.toString('base64');
      const ext = path.extname(imagePath).slice(1).toLowerCase();
      const ct = contentTypeFromExt(ext);
      const filename = path.basename(imagePath);

      const stripped = jid.replace(/^sig:/, '');
      const body: any = {
        number: this.phoneNumber,
        recipients: [stripped],
        base64_attachments: [`data:${ct};filename=${filename};base64,${base64}`],
      };
      if (caption) body.message = caption;

      const res = await fetch(`${this.apiUrl}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        logger.error({ jid, status: res.status, detail }, 'Signal image send failed');
      } else {
        logger.info({ jid, filename }, 'Signal image sent');
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal image');
    }
  }

  /** Set a reply target so the next sendMessage for this JID is a quote-reply. */
  setReplyTarget(jid: string, messageId: string): void {
    const dashIdx = messageId.indexOf('-');
    if (dashIdx > 0) {
      const timestamp = parseInt(messageId.slice(0, dashIdx), 10);
      const author = messageId.slice(dashIdx + 1);
      if (!isNaN(timestamp)) {
        this.replyTargets.set(jid, { timestamp, author });
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const MAX_LENGTH = 4000;

    // Consume reply target on first chunk only
    const replyTarget = this.replyTargets.get(jid);
    if (replyTarget) this.replyTargets.delete(jid);

    try {
      const chunks: string[] = [];
      if (text.length <= MAX_LENGTH) {
        chunks.push(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          chunks.push(text.slice(i, i + MAX_LENGTH));
        }
      }

      for (let i = 0; i < chunks.length; i++) {
        const body: any = {
          message: chunks[i],
          number: this.phoneNumber,
          text_mode: 'normal',
        };

        // Quote-reply on the first chunk only
        if (i === 0 && replyTarget) {
          body.quote_timestamp = replyTarget.timestamp;
          body.quote_author = replyTarget.author;
        }

        // Both DMs and groups use the recipients array
        const stripped = jid.replace(/^sig:/, '');
        body.recipients = [stripped];

        const res = await fetch(`${this.apiUrl}/v2/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          logger.error({ jid, status: res.status, detail }, 'Signal send failed');
        }
      }

      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  async sendReaction(
    jid: string,
    emoji: string,
    targetTimestamp: number,
    targetAuthor: string,
  ): Promise<void> {
    try {
      const stripped = jid.replace(/^sig:/, '');
      const body: any = {
        reaction: emoji,
        target_author: targetAuthor,
        timestamp: targetTimestamp,
      };

      if (stripped.startsWith('+')) {
        body.recipient = stripped;
      } else {
        // Group — use recipients array
        body.recipient = stripped;
      }

      const res = await fetch(
        `${this.apiUrl}/v1/reactions/${this.phoneNumber}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        logger.error({ jid, status: res.status, detail }, 'Signal reaction send failed');
      } else {
        logger.info({ jid, emoji, targetTimestamp }, 'Signal reaction sent');
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal reaction');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const stripped = jid.replace(/^sig:/, '');
      const method = isTyping ? 'PUT' : 'DELETE';

      const body: any = {};
      if (stripped.startsWith('+')) {
        body.recipient = stripped;
      } else if (stripped.startsWith('group.')) {
        // Decode group.xxx back to internal ID for typing API
        body.group = Buffer.from(stripped.slice('group.'.length), 'base64').toString('utf-8');
      } else {
        body.group = stripped;
      }

      await fetch(`${this.apiUrl}/v1/typing-indicator/${this.phoneNumber}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Signal typing indicator');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sig:');
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    logger.info('Signal channel stopped');
  }
}
