import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_WORKSPACES = new Set(['global']);

export function isValidWorkspace(workspace: string): boolean {
  if (!workspace) return false;
  if (workspace !== workspace.trim()) return false;
  if (!WORKSPACE_PATTERN.test(workspace)) return false;
  if (workspace.includes('/') || workspace.includes('\\')) return false;
  if (workspace.includes('..')) return false;
  if (RESERVED_WORKSPACES.has(workspace.toLowerCase())) return false;
  return true;
}

export function assertValidWorkspace(workspace: string): void {
  if (!isValidWorkspace(workspace)) {
    throw new Error(`Invalid workspace "${workspace}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveWorkspacePath(workspace: string): string {
  assertValidWorkspace(workspace);
  const groupPath = path.resolve(GROUPS_DIR, workspace);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveWorkspaceIpcPath(workspace: string): string {
  assertValidWorkspace(workspace);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, workspace);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
