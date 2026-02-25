import http from 'node:http';
import { EventEmitter } from 'node:events';

import { API_GROUP_FOLDER, API_KEY, API_PORT } from './config.js';
import { storeMessage } from './db.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';
import { formatMessages } from './router.js';
import { RegisteredGroup } from './types.js';

export const responseEmitter = new EventEmitter();

const RESPONSE_TIMEOUT = 120_000; // 2 minutes

interface ApiDeps {
  queue: GroupQueue;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

function findJidForFolder(
  groups: Record<string, RegisteredGroup>,
  folder: string,
): string | undefined {
  return Object.keys(groups).find((jid) => groups[jid].folder === folder);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

export function startApiServer(deps: ApiDeps): void {
  if (!API_KEY) {
    logger.info('API_KEY not set, HTTP API disabled');
    return;
  }

  const server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/api/health') {
      json(res, 200, { ok: true });
      return;
    }

    // Message endpoint
    if (req.method === 'POST' && req.url === '/api/message') {
      // Auth
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${API_KEY}`) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }

      let body: { content?: string; sender_name?: string };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: 'Invalid JSON' });
        return;
      }

      if (!body.content || typeof body.content !== 'string') {
        json(res, 400, { error: 'Missing "content" field' });
        return;
      }

      const groups = deps.registeredGroups();
      const jid = findJidForFolder(groups, API_GROUP_FOLDER);
      if (!jid) {
        json(res, 404, { error: `Group folder "${API_GROUP_FOLDER}" not registered` });
        return;
      }

      const senderName = body.sender_name || 'Adi (wearable)';
      const now = new Date();
      const msgId = `api-${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`;

      storeMessage({
        id: msgId,
        chat_jid: jid,
        sender: 'api',
        sender_name: senderName,
        content: body.content,
        timestamp: now.toISOString(),
        is_from_me: false,
        is_bot_message: false,
      });

      // Register one-shot listener for the response
      const responsePromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          responseEmitter.removeListener(`response:${jid}`, onResponse);
          reject(new Error('timeout'));
        }, RESPONSE_TIMEOUT);

        function onResponse(text: string) {
          clearTimeout(timer);
          resolve(text);
        }

        responseEmitter.once(`response:${jid}`, onResponse);
      });

      // Trigger processing: pipe to running container or enqueue new one
      const formatted = formatMessages([
        {
          id: msgId,
          chat_jid: jid,
          sender: 'api',
          sender_name: senderName,
          content: body.content,
          timestamp: now.toISOString(),
        },
      ]);

      if (!deps.queue.sendMessage(jid, formatted)) {
        deps.queue.enqueueMessageCheck(jid);
      }

      try {
        const response = await responsePromise;
        json(res, 200, { response });
      } catch {
        json(res, 504, { error: 'Response timeout' });
      }
      return;
    }

    // Not found
    json(res, 404, { error: 'Not found' });
  });

  server.listen(API_PORT, () => {
    logger.info({ port: API_PORT }, 'HTTP API listening');
  });
}
