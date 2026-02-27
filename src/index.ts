import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  SIGNAL_API_URL,
  SIGNAL_PHONE_NUMBER,
  groupTriggerPattern,
} from './config.js';
import { SignalChannel } from './channels/signal.js';
import {
  ContainerOutput,
  prepareAttachmentsForContainer,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound, parseSignalMessageId } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const pattern = groupTriggerPattern(group.trigger);
    const hasTrigger = missedMessages.some((m) =>
      pattern.test(m.content.trim()) || m.is_reply_to_bot,
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);

  // Prepare image attachments for container (copies files to IPC dir)
  const attachments = prepareAttachmentsForContainer(missedMessages, group.folder);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Typing indicator: show while agent is working
  if (channel.setTyping) channel.setTyping(chatJid, true).catch(() => {});

  // React with ⚡ on every pending message and set reply target
  const lastMsg = missedMessages[missedMessages.length - 1];
  if (channel.sendReaction) {
    for (const msg of missedMessages) {
      const parsed = parseSignalMessageId(msg.id);
      if (parsed) {
        channel.sendReaction(chatJid, '⚡', parsed.timestamp, parsed.author).catch(() => {});
      }
    }
  }
  if (channel.setReplyTarget) {
    channel.setReplyTarget(chatJid, lastMsg.id);
  }

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = formatOutbound(raw);
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  }, attachments);

  if (idleTimer) clearTimeout(idleTimer);
  if (channel.setTyping) channel.setTyping(chatJid, false).catch(() => {});

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    // Notify user so they know something went wrong
    channel.sendMessage(chatJid, "[System] Error processing your message. Will retry.").catch(() => {});
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  attachments?: { containerPath: string; contentType: string }[],
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        attachments: attachments?.length ? attachments : undefined,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const pattern = groupTriggerPattern(group.trigger);
            const hasTrigger = groupMessages.some((m) =>
              pattern.test(m.content.trim()) || m.is_reply_to_bot,
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          // Prepare attachments for piped messages
          const pipeAttachments = prepareAttachmentsForContainer(messagesToSend, group.folder);

          if (queue.sendMessage(chatJid, formatted, pipeAttachments.length > 0 ? pipeAttachments : undefined)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();

            // React ⚡ on piped messages too
            const pipedLastMsg = messagesToSend[messagesToSend.length - 1];
            if (channel.sendReaction) {
              const parsed = parseSignalMessageId(pipedLastMsg.id);
              if (parsed) {
                channel.sendReaction(chatJid, '⚡', parsed.timestamp, parsed.author).catch(() => {});
              }
            }

          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastAgentTimestamp and processing messages.
 * Messages older than the recovery age are considered stale and dropped — the
 * cursor is advanced past them to prevent spamming users after prolonged downtime.
 * Recovery age is configurable per group via containerConfig.recoveryAge (seconds).
 */
function recoverPendingMessages(): void {
  const DEFAULT_RECOVERY_AGE_S = 86400; // 1 day

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const recoveryAgeMs = (group.containerConfig?.recoveryAge ?? DEFAULT_RECOVERY_AGE_S) * 1000;
    const cutoff = new Date(Date.now() - recoveryAgeMs).toISOString();

    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    const recent = pending.filter((m) => m.timestamp >= cutoff);

    if (recent.length < pending.length) {
      const stale = pending.filter((m) => m.timestamp < cutoff);
      logger.info(
        {
          group: group.name,
          skipped: stale.length,
          dropped: stale.map((m) => ({ id: m.id, sender: m.sender_name, ts: m.timestamp })),
        },
        'Recovery: dropping stale messages older than %ds',
        recoveryAgeMs / 1000,
      );
      // Advance cursor past stale messages so they're never reprocessed
      if (stale.length > 0) {
        lastAgentTimestamp[chatJid] = stale[stale.length - 1].timestamp;
        saveState();
      }
    }

    if (recent.length > 0) {
      logger.info(
        { group: group.name, pendingCount: recent.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}


const PID_FILE = '/tmp/nanoclaw.pid';

function writePidFile(): void {
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function removePidFile(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

function checkPidFile(): void {
  let existingPid: number | null = null;
  try {
    const content = fs.readFileSync(PID_FILE, 'utf-8').trim();
    existingPid = parseInt(content, 10);
  } catch {
    // No PID file — first run
    return;
  }

  if (!existingPid || isNaN(existingPid)) return;

  try {
    process.kill(existingPid, 0);
    // If we get here, the process is still running
    logger.error(
      { pid: existingPid },
      `Another NanoClaw process is already running (PID ${existingPid}). Exiting.`,
    );
    process.exit(1);
  } catch {
    // Process not running — stale PID file, safe to proceed
    logger.warn({ pid: existingPid }, 'Stale PID file found, proceeding');
  }
}

async function main(): Promise<void> {
  checkPidFile();
  writePidFile();
  // Clean up PID file on any exit, including uncaught exceptions
  process.on('exit', removePidFile);

  await ensureContainerRuntimeRunning();
  cleanupOrphans();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    removePidFile();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  if (SIGNAL_PHONE_NUMBER) {
    const signal = new SignalChannel(SIGNAL_API_URL, SIGNAL_PHONE_NUMBER, channelOpts);
    channels.push(signal);
    await signal.connect();
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText);
      if (!text) return Promise.resolve();
      return channel.sendMessage(jid, text);
    },
    sendReaction: (jid, emoji, targetTimestamp, targetAuthor) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendReaction) {
        return channel.sendReaction(jid, emoji, targetTimestamp, targetAuthor);
      }
      return Promise.resolve(); // Channel doesn't support reactions
    },
    sendImage: (jid, imagePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendImage) return channel.sendImage(jid, imagePath, caption);
      return Promise.resolve(); // Channel doesn't support images
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: () => Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
