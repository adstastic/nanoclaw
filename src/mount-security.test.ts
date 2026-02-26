import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mock logger
vi.mock('pino', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { default: () => logger };
});

// Mock config — provide a stable allowlist path
const TEST_ALLOWLIST_PATH = '/tmp/test-mount-allowlist.json';
vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: TEST_ALLOWLIST_PATH,
}));

// We need to reset the module-level cache between tests.
// Re-import fresh module for each test via dynamic import.
let validateMount: typeof import('./mount-security.js').validateMount;
let validateAdditionalMounts: typeof import('./mount-security.js').validateAdditionalMounts;
let loadMountAllowlist: typeof import('./mount-security.js').loadMountAllowlist;

async function reimportModule() {
  vi.resetModules();
  const mod = await import('./mount-security.js');
  validateMount = mod.validateMount;
  validateAdditionalMounts = mod.validateAdditionalMounts;
  loadMountAllowlist = mod.loadMountAllowlist;
}

// Helpers
const homeDir = os.homedir();

function writeAllowlist(config: {
  allowedRoots?: Array<{ path: string; allowReadWrite: boolean; description?: string }>;
  blockedPatterns?: string[];
  nonMainReadOnly?: boolean;
}) {
  fs.writeFileSync(TEST_ALLOWLIST_PATH, JSON.stringify({
    allowedRoots: config.allowedRoots || [],
    blockedPatterns: config.blockedPatterns || [],
    nonMainReadOnly: config.nonMainReadOnly ?? true,
  }));
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-sec-test-'));
  await reimportModule();
});

afterEach(() => {
  try { fs.unlinkSync(TEST_ALLOWLIST_PATH); } catch { /* ok */ }
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
});

// --- loadMountAllowlist ---

describe('loadMountAllowlist', () => {
  it('returns null when allowlist file does not exist', () => {
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('loads and caches a valid allowlist', () => {
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
    });
    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result!.allowedRoots).toHaveLength(1);
    // Second call returns cached
    const result2 = loadMountAllowlist();
    expect(result2).toBe(result);
  });

  it('merges default blocked patterns with user patterns', () => {
    writeAllowlist({
      allowedRoots: [],
      blockedPatterns: ['my-custom-secret'],
    });
    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    // Should contain both default (.ssh, .env, etc.) and custom patterns
    expect(result!.blockedPatterns).toContain('.ssh');
    expect(result!.blockedPatterns).toContain('.env');
    expect(result!.blockedPatterns).toContain('my-custom-secret');
  });

  it('returns null for malformed JSON', () => {
    fs.writeFileSync(TEST_ALLOWLIST_PATH, '{invalid json');
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when allowedRoots is missing', () => {
    fs.writeFileSync(TEST_ALLOWLIST_PATH, JSON.stringify({
      blockedPatterns: [],
      nonMainReadOnly: true,
    }));
    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });
});

// --- validateMount ---

describe('validateMount', () => {
  it('blocks all mounts when no allowlist exists', () => {
    const result = validateMount(
      { hostPath: tmpDir },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist');
  });

  it('allows mount under an allowed root', () => {
    const subDir = path.join(tmpDir, 'project');
    fs.mkdirSync(subDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
    });

    const result = validateMount(
      { hostPath: subDir },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe(fs.realpathSync(subDir));
  });

  it('blocks mount outside any allowed root', () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-other-'));
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
    });

    const result = validateMount(
      { hostPath: otherDir },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
    fs.rmSync(otherDir, { recursive: true });
  });

  it('blocks paths matching blocked patterns (.ssh)', () => {
    const sshDir = path.join(tmpDir, '.ssh');
    fs.mkdirSync(sshDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
    });

    const result = validateMount(
      { hostPath: sshDir },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('blocks paths matching blocked pattern (.env)', () => {
    const envFile = path.join(tmpDir, '.env');
    fs.writeFileSync(envFile, 'SECRET=value');
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
    });

    const result = validateMount(
      { hostPath: envFile },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.env');
  });

  it('blocks paths matching credentials pattern', () => {
    const credDir = path.join(tmpDir, 'credentials');
    fs.mkdirSync(credDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
    });

    const result = validateMount(
      { hostPath: credDir },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('credentials');
  });

  it('resolves symlinks before checking blocked patterns', () => {
    const realSsh = path.join(tmpDir, '.ssh');
    fs.mkdirSync(realSsh);
    const symlink = path.join(tmpDir, 'innocent-link');
    fs.symlinkSync(realSsh, symlink);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
    });

    const result = validateMount(
      { hostPath: symlink },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('blocks non-existent host paths', () => {
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
    });

    const result = validateMount(
      { hostPath: '/nonexistent/path/here' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('rejects container path with .. traversal', () => {
    const subDir = path.join(tmpDir, 'safe');
    fs.mkdirSync(subDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
    });

    const result = validateMount(
      { hostPath: subDir, containerPath: '../escape' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('..');
  });

  it('rejects absolute container path', () => {
    const subDir = path.join(tmpDir, 'safe');
    fs.mkdirSync(subDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
    });

    const result = validateMount(
      { hostPath: subDir, containerPath: '/etc/shadow' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('must be relative');
  });

  it('forces read-only for non-main groups when nonMainReadOnly is true', () => {
    const subDir = path.join(tmpDir, 'data');
    fs.mkdirSync(subDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      nonMainReadOnly: true,
    });

    const result = validateMount(
      { hostPath: subDir, readonly: false },
      false, // non-main
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows read-write for main group even when nonMainReadOnly is true', () => {
    const subDir = path.join(tmpDir, 'data');
    fs.mkdirSync(subDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      nonMainReadOnly: true,
    });

    const result = validateMount(
      { hostPath: subDir, readonly: false },
      true, // main
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('forces read-only when root does not allow read-write', () => {
    const subDir = path.join(tmpDir, 'docs');
    fs.mkdirSync(subDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: false }],
      nonMainReadOnly: false,
    });

    const result = validateMount(
      { hostPath: subDir, readonly: false },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('derives container path from host path basename when not specified', () => {
    const subDir = path.join(tmpDir, 'my-project');
    fs.mkdirSync(subDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
    });

    const result = validateMount(
      { hostPath: subDir },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('my-project');
  });
});

// --- validateAdditionalMounts ---

describe('validateAdditionalMounts', () => {
  it('returns only mounts that pass validation', () => {
    const goodDir = path.join(tmpDir, 'good');
    fs.mkdirSync(goodDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
    });

    const result = validateAdditionalMounts(
      [
        { hostPath: goodDir },
        { hostPath: '/nonexistent' },
      ],
      'test-group',
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0].containerPath).toBe(`/workspace/extra/good`);
  });

  it('returns empty array when all mounts are rejected', () => {
    writeAllowlist({ allowedRoots: [] });

    const result = validateAdditionalMounts(
      [{ hostPath: tmpDir }],
      'test-group',
      true,
    );
    expect(result).toHaveLength(0);
  });

  it('sets correct readonly flag on output', () => {
    const subDir = path.join(tmpDir, 'rw-dir');
    fs.mkdirSync(subDir);
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      nonMainReadOnly: false,
    });

    const result = validateAdditionalMounts(
      [{ hostPath: subDir, readonly: false }],
      'test-group',
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0].readonly).toBe(false);
  });
});
