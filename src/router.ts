import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) =>
    `<message id="${escapeXml(m.id)}" sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function routeOutboundImage(
  channels: Channel[],
  jid: string,
  imagePath: string,
  caption?: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (!channel.sendImage) throw new Error(`Channel ${channel.name} does not support sending images`);
  return channel.sendImage(jid, imagePath, caption);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

/**
 * Parse a Signal-style message ID "{timestamp}-{phoneNumber}".
 * Returns null if the format doesn't match.
 */
export function parseSignalMessageId(id: string): { timestamp: number; author: string } | null {
  const dashIdx = id.indexOf('-');
  if (dashIdx <= 0) return null;
  const timestamp = parseInt(id.slice(0, dashIdx), 10);
  if (isNaN(timestamp)) return null;
  return { timestamp, author: id.slice(dashIdx + 1) };
}
