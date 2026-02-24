/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['--mount', `type=bind,source=${hostPath},target=${containerPath},readonly`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, retrying with backoff on startup. */
export async function ensureContainerRuntimeRunning(): Promise<void> {
  const MAX_RETRIES = 30;
  const RETRY_INTERVAL_MS = 5000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
      logger.debug('Container runtime is running');
      return;
    } catch {
      // Try to start the runtime
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} system start`, { stdio: 'pipe', timeout: 30000 });
        logger.info('Container runtime started');
        return;
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          logger.error({ err }, 'Container runtime not reachable after %d attempts', MAX_RETRIES);
          throw new Error('Container runtime is required but not reachable');
        }
        logger.info(
          { err },
          'Waiting for container runtime (attempt %d/%d, next retry in %ds)',
          attempt, MAX_RETRIES, RETRY_INTERVAL_MS / 1000,
        );
        await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
      }
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] = JSON.parse(output || '[]');
    const orphans = containers
      .filter((c) => c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'))
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
