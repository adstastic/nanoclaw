import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  workspace: string | null;
  lastTriggerJid: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private resolveFolder: (jid: string) => string;

  constructor(resolveFolder?: (jid: string) => string) {
    this.resolveFolder = resolveFolder ?? ((jid) => jid);
  }

  /** Resolve a JID to the Map key (folder when resolver is set, JID otherwise). */
  private resolveKey(groupJid: string): string {
    return this.resolveFolder(groupJid) ?? groupJid;
  }

  private getGroup(key: string): GroupState {
    let state = this.groups.get(key);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        workspace: null,
        lastTriggerJid: null,
        retryCount: 0,
      };
      this.groups.set(key, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const key = this.resolveKey(groupJid);
    const state = this.getGroup(key);
    state.lastTriggerJid = groupJid;

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid, key }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(key)) {
        this.waitingGroups.push(key);
      }
      logger.debug(
        { groupJid, key, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(key, 'messages').catch((err) =>
      logger.error({ groupJid, key, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const key = this.resolveKey(groupJid);
    const state = this.getGroup(key);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdinByKey(key);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(key)) {
        this.waitingGroups.push(key);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(key, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(groupJid: string, proc: ChildProcess, containerName: string, workspace?: string): void {
    const key = this.resolveKey(groupJid);
    const state = this.getGroup(key);
    state.process = proc;
    state.containerName = containerName;
    if (workspace) state.workspace = workspace;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const key = this.resolveKey(groupJid);
    const state = this.getGroup(key);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdinByKey(key);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(
    groupJid: string,
    text: string,
    attachments?: { containerPath: string; contentType: string }[],
  ): boolean {
    const key = this.resolveKey(groupJid);
    const state = this.getGroup(key);
    if (!state.active || !state.workspace || state.isTaskContainer) return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.workspace, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      const payload: any = { type: 'message', text };
      if (attachments && attachments.length > 0) payload.attachments = attachments;
      fs.writeFileSync(tempPath, JSON.stringify(payload));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   * Public API accepts a JID and resolves to the folder key.
   */
  closeStdin(groupJid: string): void {
    const key = this.resolveKey(groupJid);
    this.closeStdinByKey(key);
  }

  /** Internal: close stdin by folder key (avoids double-resolution). */
  private closeStdinByKey(key: string): void {
    const state = this.getGroup(key);
    if (!state.active || !state.workspace) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.workspace, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    key: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(key);
    const jid = state.lastTriggerJid || key;
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupJid: jid, key, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(jid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(key, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid: jid, key, err }, 'Error processing messages for group');
      this.scheduleRetry(key, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.workspace = null;
      this.activeCount--;
      this.drainGroup(key);
    }
  }

  private async runTask(key: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(key);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    this.activeCount++;

    logger.debug(
      { groupJid: task.groupJid, key, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid: task.groupJid, key, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.process = null;
      state.containerName = null;
      state.workspace = null;
      this.activeCount--;
      this.drainGroup(key);
    }
  }

  private scheduleRetry(key: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { key, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const jid = state.lastTriggerJid || key;
    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid: jid, key, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(jid);
      }
    }, delayMs);
  }

  private drainGroup(key: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(key);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(key, task).catch((err) =>
        logger.error({ key, taskId: task.id, err }, 'Unhandled error in runTask (drain)'),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(key, 'drain').catch((err) =>
        logger.error({ key, err }, 'Unhandled error in runForGroup (drain)'),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextKey = this.waitingGroups.shift()!;
      const state = this.getGroup(nextKey);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextKey, task).catch((err) =>
          logger.error({ key: nextKey, taskId: task.id, err }, 'Unhandled error in runTask (waiting)'),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextKey, 'drain').catch((err) =>
          logger.error({ key: nextKey, err }, 'Unhandled error in runForGroup (waiting)'),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [_key, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
