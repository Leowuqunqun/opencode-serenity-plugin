/**
 * safe-mode.test.ts — Safe mode + write blacklist tests
 *
 * Covers:
 * 1. isSafeModeOn() state detection
 * 2. setSafeMode() toggle
 * 3. readBlacklist() config parsing
 * 4. isPathBlacklisted() prefix + regex matching
 * 5. tool.execute.before — blacklist blocks write/edit in safe mode
 * 6. tool.execute.before — bash blocked in safe mode
 * 7. tool.execute.before — safe mode off = no blocking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isSafeModeOn,
  setSafeMode,
  readBlacklist,
  isPathBlacklisted,
  matchBlacklistEntry,
} from '../src/safe-mode.js';
import { setState, resetState } from '../src/state.js';

const INSTANCE = 'test-ccc';

function setupCccRoot(withConfig?: Record<string, unknown>): string {
  const tmp = mkdtempSync(join(tmpdir(), 'safe-mode-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
  writeFileSync(join(tmp, '.serenity'), INSTANCE);
  const skillDir = join(tmp, '.opencode', 'skills', INSTANCE);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# test skill');
  if (withConfig) {
    const configDir = join(tmp, '.opencode');
    writeFileSync(join(configDir, 'serenity.json'), JSON.stringify(withConfig));
  }
  execFileSync('git', ['add', '-A'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp, stdio: 'ignore' });
  return tmp;
}

function writeMarker(root: string, name: string): void {
  writeFileSync(join(root, name), '', 'utf-8');
}

describe('isSafeModeOn()', () => {
  it('default: OFF (no marker, no env)', () => {
    const root = setupCccRoot();
    // Override server mode detection with env var
    process.env.SERENITY_SAFE_MODE = 'false';
    expect(isSafeModeOn(root)).toBe(false);
    delete process.env.SERENITY_SAFE_MODE;
    rmSync(root, { recursive: true, force: true });
  });

  it('ON when .serenity-safe-on marker exists', () => {
    const root = setupCccRoot();
    writeMarker(root, '.serenity-safe-on');
    expect(isSafeModeOn(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('backward compat: .serenity-bash-off → ON', () => {
    const root = setupCccRoot();
    writeMarker(root, '.serenity-bash-off');
    expect(isSafeModeOn(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('SERENITY_SAFE_MODE=true env var → ON', () => {
    process.env.SERENITY_SAFE_MODE = 'true';
    expect(isSafeModeOn()).toBe(true);
    delete process.env.SERENITY_SAFE_MODE;
  });

  it('SERENITY_SAFE_MODE=false env var → OFF', () => {
    process.env.SERENITY_SAFE_MODE = 'false';
    expect(isSafeModeOn()).toBe(false);
    delete process.env.SERENITY_SAFE_MODE;
  });
});

describe('setSafeMode()', () => {
  it('creates .serenity-safe-on when set to true', () => {
    const root = setupCccRoot();
    setSafeMode(true, root);
    expect(isSafeModeOn(root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('removes .serenity-safe-on when set to false', () => {
    const root = setupCccRoot();
    writeMarker(root, '.serenity-safe-on');
    setSafeMode(false, root);
    expect(isSafeModeOn(root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('readBlacklist()', () => {
  it('no config file → empty', () => {
    const root = setupCccRoot();
    expect(readBlacklist(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('empty blacklist → empty', () => {
    const root = setupCccRoot({ safeMode: { blacklist: [] } });
    expect(readBlacklist(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('prefix patterns', () => {
    const root = setupCccRoot({ safeMode: { blacklist: ['/etc/', '/usr/'] } });
    const entries = readBlacklist(root);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ type: 'prefix', pattern: '/etc/' });
    expect(entries[1]).toEqual({ type: 'prefix', pattern: '/usr/' });
    rmSync(root, { recursive: true, force: true });
  });

  it('regex patterns (prefixed with regex:)', () => {
    const root = setupCccRoot({ safeMode: { blacklist: ['regex:\\.git/', 'regex:^/var/log'] } });
    const entries = readBlacklist(root);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ type: 'regex', pattern: '\\.git/' });
    expect(entries[1]).toEqual({ type: 'regex', pattern: '^/var/log' });
    rmSync(root, { recursive: true, force: true });
  });

  it('malformed patterns are filtered out', () => {
    const root = setupCccRoot({ safeMode: { blacklist: ['/etc/', null, 123, 'regex:'] } });
    const entries = readBlacklist(root);
    expect(entries).toHaveLength(1); // only /etc/
    rmSync(root, { recursive: true, force: true });
  });

  it('object form with custom message', () => {
    const root = setupCccRoot({
      safeMode: { blacklist: [{ pattern: '/etc/', message: '禁止修改系统目录' }] },
    });
    const entries = readBlacklist(root);
    expect(entries).toEqual([{ type: 'prefix', pattern: '/etc/', message: '禁止修改系统目录' }]);
    rmSync(root, { recursive: true, force: true });
  });

  it('mixed string + object forms', () => {
    const root = setupCccRoot({
      safeMode: {
        blacklist: [
          '/etc/',
          { pattern: 'regex:\\.secret/', message: '禁止写入 .secret' },
        ],
      },
    });
    const entries = readBlacklist(root);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ type: 'prefix', pattern: '/etc/' });
    expect(entries[1]).toEqual({ type: 'regex', pattern: '\\.secret/', message: '禁止写入 .secret' });
    rmSync(root, { recursive: true, force: true });
  });

  it('object form without message → undefined', () => {
    const root = setupCccRoot({ safeMode: { blacklist: [{ pattern: '/tmp/' }] } });
    const entries = readBlacklist(root);
    expect(entries).toEqual([{ type: 'prefix', pattern: '/tmp/' }]);
    rmSync(root, { recursive: true, force: true });
  });

  it('invalid object entries filtered out', () => {
    const root = setupCccRoot({ safeMode: { blacklist: [{ message: 'no pattern' }, {}, 'regex:'] } });
    const entries = readBlacklist(root);
    expect(entries).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('matchBlacklistEntry()', () => {
  it('returns the matched entry with custom message', () => {
    const entries = [
      { type: 'prefix' as const, pattern: '/etc/', message: '禁止修改系统目录' },
      { type: 'regex' as const, pattern: '\\.secret/' },
    ];
    const hit = matchBlacklistEntry('/etc/passwd', entries);
    expect(hit).toEqual({ type: 'prefix', pattern: '/etc/', message: '禁止修改系统目录' });
    expect(matchBlacklistEntry('/a/.secret/x', entries)).toEqual({ type: 'regex', pattern: '\\.secret/' });
    expect(matchBlacklistEntry('/tmp/x', entries)).toBeNull();
  });
});

describe('isPathBlacklisted()', () => {
  const prefixEntries = [
    { type: 'prefix' as const, pattern: '/etc/' },
    { type: 'prefix' as const, pattern: '/home/yh/.ssh/' },
  ];
  const regexEntries = [
    { type: 'regex' as const, pattern: '\\.git/' },
    { type: 'regex' as const, pattern: '^/var/log' },
  ];

  it('prefix match: /etc/passwd → blocked', () => {
    expect(isPathBlacklisted('/etc/passwd', prefixEntries)).toBe(true);
  });

  it('prefix match: /etc/ → blocked', () => {
    expect(isPathBlacklisted('/etc/', prefixEntries)).toBe(true);
  });

  it('prefix match: /usr/bin → not blocked', () => {
    expect(isPathBlacklisted('/usr/bin', prefixEntries)).toBe(false);
  });

  it('prefix match: /home/yh/.ssh/id_rsa → blocked', () => {
    expect(isPathBlacklisted('/home/yh/.ssh/id_rsa', prefixEntries)).toBe(true);
  });

  it('regex match: /repo/.git/config → blocked', () => {
    expect(isPathBlacklisted('/repo/.git/config', regexEntries)).toBe(true);
  });

  it('regex match: /var/log/syslog → blocked', () => {
    expect(isPathBlacklisted('/var/log/syslog', regexEntries)).toBe(true);
  });

  it('regex match: /opt/app/log → not blocked', () => {
    expect(isPathBlacklisted('/opt/app/log', regexEntries)).toBe(false);
  });

  it('invalid regex pattern → skip (no throw)', () => {
    const bad = [{ type: 'regex' as const, pattern: '[invalid' }];
    expect(() => isPathBlacklisted('/test', bad)).not.toThrow();
    expect(isPathBlacklisted('/test', bad)).toBe(false);
  });

  it('empty blacklist → no block', () => {
    expect(isPathBlacklisted('/etc/passwd', [])).toBe(false);
  });
});

// ── Integration: tool.execute.before hook ──

describe('tool.execute.before blacklist integration', () => {
  let cwd = '';
  let hook: NonNullable<import('@opencode-ai/plugin').Hooks['tool.execute.before']>;

  beforeEach(async () => {
    resetState();
    cwd = setupCccRoot({ safeMode: { blacklist: ['regex:\\.secret/'] } });
    setState({ activated: true, cwdRoot: cwd, cccName: INSTANCE, skillPath: '', skillContent: null, needsPhase2: false, phase2Prompt: null });
    const mod = await import('../src/hooks/permission-guards.js');
    hook = (mod as any).createPermissionGuards()[ 'tool.execute.before' ];
  });

  afterEach(() => {
    resetState();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it('safe mode ON + write to blacklisted path (inside root) → throws', async () => {
    writeMarker(cwd, '.serenity-safe-on');
    const blacklistedPath = join(cwd, '.secret/credentials.json');
    await expect(
      hook({ tool: 'write' } as any, { args: { filePath: blacklistedPath } } as any),
    ).rejects.toThrow(/not allowed/);
  });

  it('safe mode ON + edit to blacklisted path (inside root) → throws', async () => {
    writeMarker(cwd, '.serenity-safe-on');
    const blacklistedPath = join(cwd, '.secret/config.yml');
    await expect(
      hook({ tool: 'edit' } as any, { args: { filePath: blacklistedPath } } as any),
    ).rejects.toThrow(/not allowed/);
  });

  it('safe mode ON + write to non-blacklisted path (inside root) → allowed', async () => {
    writeMarker(cwd, '.serenity-safe-on');
    const safePath = join(cwd, 'test.md');
    await expect(
      hook({ tool: 'write' } as any, { args: { filePath: safePath } } as any),
    ).resolves.toBeUndefined();
  });

  it('safe mode OFF + write to blacklisted path → allowed', async () => {
    const blacklistedPath = join(cwd, '.secret/credentials.json');
    await expect(
      hook({ tool: 'write' } as any, { args: { filePath: blacklistedPath } } as any),
    ).resolves.toBeUndefined();
  });

  it('safe mode ON + bash → throws', async () => {
    writeMarker(cwd, '.serenity-safe-on');
    await expect(
      hook({ tool: 'bash' } as any, { args: { command: 'ls' } } as any),
    ).rejects.toThrow(/bash is disabled/);
  });

  it('safe mode OFF + bash → allowed', async () => {
    await expect(
      hook({ tool: 'bash' } as any, { args: { command: 'ls' } } as any),
    ).resolves.toBeUndefined();
  });
});
