import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_WORKSPACE,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { parseSignalMessageId } from './router.js';
import { isValidWorkspace } from './workspace.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/**
 * Map a container-relative path back to its host filesystem location.
 * Includes path traversal protection — resolved path must stay within the expected base.
 */
function containerToHostPath(containerPath: string, workspace: string): string {
  let baseDir: string;
  let relative: string;

  if (containerPath.startsWith('/workspace/ipc/')) {
    baseDir = path.join(DATA_DIR, 'ipc', workspace);
    relative = containerPath.slice('/workspace/ipc/'.length);
  } else if (containerPath.startsWith('/workspace/group/')) {
    baseDir = path.join(GROUPS_DIR, workspace);
    relative = containerPath.slice('/workspace/group/'.length);
  } else {
    throw new Error(`Cannot map container path to host: ${containerPath}`);
  }

  const resolved = path.resolve(baseDir, relative);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    throw new Error(`Path traversal detected: ${containerPath}`);
  }
  return resolved;
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendReaction?: (jid: string, emoji: string, targetTimestamp: number, targetAuthor: string) => Promise<void>;
  sendImage?: (jid: string, imagePath: string, caption?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    workspace: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let workspaces: string[];
    try {
      workspaces = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceWorkspace of workspaces) {
      const isMain = sourceWorkspace === MAIN_WORKSPACE;
      const messagesDir = path.join(ipcBaseDir, sourceWorkspace, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceWorkspace, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'))
            .sort();
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.workspace === sourceWorkspace)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceWorkspace },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceWorkspace },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'reaction' && data.chatJid && data.emoji && data.messageId && deps.sendReaction) {
                const parsed = parseSignalMessageId(data.messageId as string);
                if (parsed) {
                  const targetGroup = registeredGroups[data.chatJid];
                  if (
                    isMain ||
                    (targetGroup && targetGroup.workspace === sourceWorkspace)
                  ) {
                    await deps.sendReaction(data.chatJid, data.emoji as string, parsed.timestamp, parsed.author);
                    logger.info(
                      { chatJid: data.chatJid, emoji: data.emoji, sourceWorkspace },
                      'IPC reaction sent',
                    );
                  } else {
                    logger.warn(
                      { chatJid: data.chatJid, sourceWorkspace },
                      'Unauthorized IPC reaction attempt blocked',
                    );
                  }
                } else {
                  logger.warn({ messageId: data.messageId }, 'Invalid message ID for reaction');
                }
              } else if (data.type === 'image' && data.chatJid && data.imagePath && deps.sendImage) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.workspace === sourceWorkspace)
                ) {
                  try {
                    const hostPath = containerToHostPath(data.imagePath as string, sourceWorkspace);
                    if (fs.existsSync(hostPath)) {
                      await deps.sendImage(data.chatJid, hostPath, data.caption as string | undefined);
                      logger.info(
                        { chatJid: data.chatJid, sourceWorkspace },
                        'IPC image sent',
                      );
                    } else {
                      logger.error(
                        { imagePath: data.imagePath, hostPath, sourceWorkspace },
                        'IPC image file not found on host',
                      );
                    }
                  } catch (err) {
                    logger.error(
                      { imagePath: data.imagePath, sourceWorkspace, err },
                      'Failed to map or send IPC image',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceWorkspace },
                    'Unauthorized IPC image attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceWorkspace, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceWorkspace}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceWorkspace },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceWorkspace, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceWorkspace, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceWorkspace}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceWorkspace }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    workspace?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceWorkspace: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetWorkspace = targetGroupEntry.workspace;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetWorkspace !== sourceWorkspace) {
          logger.warn(
            { sourceWorkspace, targetWorkspace },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          workspace: targetWorkspace,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceWorkspace, targetWorkspace, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.workspace === sourceWorkspace)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceWorkspace },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceWorkspace },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.workspace === sourceWorkspace)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceWorkspace },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceWorkspace },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.workspace === sourceWorkspace)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceWorkspace },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceWorkspace },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceWorkspace },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceWorkspace,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceWorkspace },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceWorkspace },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.workspace && data.trigger) {
        if (!isValidWorkspace(data.workspace)) {
          logger.warn(
            { sourceWorkspace, workspace: data.workspace },
            'Invalid register_group request - unsafe workspace name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          workspace: data.workspace,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
