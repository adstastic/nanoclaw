import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fns so tests can configure them
const mockExecSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainerArgs,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns --mount flag with type=bind and readonly', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual([
      '--mount',
      'type=bind,source=/host/path,target=/container/path,readonly',
    ]);
  });
});

describe('stopContainerArgs', () => {
  it('returns args array for execFileSync', () => {
    expect(stopContainerArgs('nanoclaw-test-123')).toEqual([
      CONTAINER_RUNTIME_BIN,
      'stop',
      'nanoclaw-test-123',
    ]);
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('resolves immediately when runtime is already running', async () => {
    mockExecSync.mockReturnValueOnce('');

    await ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} system status`,
      { stdio: 'pipe' },
    );
    expect(logger.debug).toHaveBeenCalledWith('Container runtime is running');
  });

  it('auto-starts when system status fails', async () => {
    // First call (system status) fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });
    // Second call (system start) succeeds
    mockExecSync.mockReturnValueOnce('');

    await ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} system start`,
      { stdio: 'pipe', timeout: 30000 },
    );
    expect(logger.info).toHaveBeenCalledWith('Container runtime started');
  });

  it('retries when both status and start fail', async () => {
    vi.useFakeTimers();
    // First attempt: status fails, start fails
    mockExecSync
      .mockImplementationOnce(() => { throw new Error('not ready'); })
      .mockImplementationOnce(() => { throw new Error('start failed'); })
      // Second attempt: status succeeds
      .mockReturnValueOnce('');

    const promise = ensureContainerRuntimeRunning();
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('throws after max retries', async () => {
    vi.useFakeTimers();
    mockExecSync.mockImplementation(() => { throw new Error('not ready'); });

    const promise = ensureContainerRuntimeRunning().catch((e: Error) => e);
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('Container runtime is required but not reachable');
    vi.useRealTimers();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers from JSON output', () => {
    // Apple Container ls returns JSON
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-group1-111' } },
      { status: 'stopped', configuration: { id: 'nanoclaw-group2-222' } },
      { status: 'running', configuration: { id: 'nanoclaw-group3-333' } },
      { status: 'running', configuration: { id: 'other-container' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);

    cleanupOrphans();

    // ls via execSync + 2 stop calls via execFileSync (only running nanoclaw- containers)
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      1,
      CONTAINER_RUNTIME_BIN,
      ['stop', 'nanoclaw-group1-111'],
      { stdio: 'pipe' },
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      CONTAINER_RUNTIME_BIN,
      ['stop', 'nanoclaw-group3-333'],
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group3-333'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('[]');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ls fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-a-1' } },
      { status: 'running', configuration: { id: 'nanoclaw-b-2' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    // First stop fails
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecFileSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});
