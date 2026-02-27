import path from 'path';

import { describe, expect, it } from 'vitest';

import { isValidWorkspace, resolveWorkspacePath, resolveWorkspaceIpcPath } from './workspace.js';

describe('workspace validation', () => {
  it('accepts normal workspace names', () => {
    expect(isValidWorkspace('main')).toBe(true);
    expect(isValidWorkspace('family-chat')).toBe(true);
    expect(isValidWorkspace('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidWorkspace('../../etc')).toBe(false);
    expect(isValidWorkspace('/tmp')).toBe(false);
    expect(isValidWorkspace('global')).toBe(false);
    expect(isValidWorkspace('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveWorkspacePath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}groups${path.sep}family-chat`),
    ).toBe(true);
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveWorkspaceIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe workspace names', () => {
    expect(() => resolveWorkspacePath('../../etc')).toThrow();
    expect(() => resolveWorkspaceIpcPath('/tmp')).toThrow();
  });
});
