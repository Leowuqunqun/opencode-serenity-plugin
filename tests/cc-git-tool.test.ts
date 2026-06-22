/**
 * cc-git tool 测试
 *
 * 测试范围：
 *   - status: clean repo, dirty repo
 *   - commit: with changes, no changes, missing message
 *   - push: no remote, has remote
 *   - log: empty repo, with commits
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ccGitTool } from '../src/git/cc-git-tool.js';

function execGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trimEnd();
}

function createSerenityInstance(): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-git-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.serenity'), 'test-git');
  const skillDir = join(root, '.opencode', 'skills', 'test-git');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# test');
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  return root;
}

function mockCtx(root: string) {
  return { directory: root } as any;
}

async function callGit(input: Record<string, any>, root: string): Promise<string> {
  return ccGitTool.execute(input, mockCtx(root)) as Promise<string>;
}

describe('cc-git tool — status', () => {
  let root: string;

  beforeEach(() => { root = createSerenityInstance(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reports clean working tree after init', async () => {
    const result = await callGit({ subcommand: 'status' }, root);
    const parsed = JSON.parse(result);
    expect(parsed.clean).toBe(true);
    expect(parsed.summary).toBe('(clean)');
    expect(parsed.files).toEqual([]);
  });

  it('reports dirty working tree with unstaged file', async () => {
    writeFileSync(join(root, 'new-file.txt'), 'hello');
    const result = await callGit({ subcommand: 'status' }, root);
    const parsed = JSON.parse(result);
    expect(parsed.clean).toBe(false);
    expect(parsed.files.length).toBe(1);
    expect(parsed.files[0].file).toBe('new-file.txt');
  });

  it('reports dirty working tree with modified file', async () => {
    writeFileSync(join(root, '.serenity'), 'modified');
    const result = await callGit({ subcommand: 'status' }, root);
    const parsed = JSON.parse(result);
    expect(parsed.clean).toBe(false);
    expect(parsed.files.length).toBe(1);
  });
});

describe('cc-git tool — commit', () => {
  let root: string;

  beforeEach(() => { root = createSerenityInstance(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('commits staged changes', async () => {
    writeFileSync(join(root, 'committed-file.txt'), 'data');
    const result = await callGit({ subcommand: 'commit', message: 'feat: test commit' }, root);
    expect(result).toContain('feat: test commit');
    // Verify commit exists
    const log = execGit(['log', '--oneline'], root);
    expect(log).toContain('feat: test commit');
  });

  it('returns clean message when nothing to commit', async () => {
    const result = await callGit({ subcommand: 'commit', message: 'no changes' }, root);
    expect(result).toContain('nothing to commit');
  });

  it('throws on missing message', async () => {
    await expect(
      callGit({ subcommand: 'commit' }, root),
    ).rejects.toThrow('missing required arg');
  });
});

describe('cc-git tool — push', () => {
  let root: string;

  beforeEach(() => { root = createSerenityInstance(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('throws when no remote configured', async () => {
    await expect(
      callGit({ subcommand: 'push' }, root),
    ).rejects.toThrow('no remote configured');
  });

  it('pushes successfully when remote exists', async () => {
    // Create a bare repo as "remote" in temp
    const barePath = mkdtempSync(join(tmpdir(), 'cc-git-remote-'));
    execFileSync('git', ['init', '--bare'], { cwd: barePath, stdio: 'ignore' });

    // Add remote pointing to the bare repo
    execFileSync('git', ['remote', 'add', 'origin', barePath], { cwd: root, stdio: 'ignore' });

    const result = await callGit({ subcommand: 'push' }, root);
    // Should succeed (push to bare repo with matching branch)
    expect(result).toBeTruthy();

    // Cleanup bare repo
    rmSync(barePath, { recursive: true, force: true });
  });
});

describe('cc-git tool — log', () => {
  let root: string;

  beforeEach(() => { root = createSerenityInstance(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('shows commit history', async () => {
    const result = await callGit({ subcommand: 'log' }, root);
    expect(result).toContain('init');
  });

  it('respects -n limit', async () => {
    // Add 3 more commits
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(root, `file-${i}.txt`), `content ${i}`);
      execGit(['add', '-A'], root);
      execGit(['commit', '-m', `commit ${i}`], root);
    }

    const result = await callGit({ subcommand: 'log', n: 2 }, root);
    const lines = result.split('\n').filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('handles empty repo gracefully', async () => {
    // Create a fresh empty git repo
    const emptyRoot = mkdtempSync(join(tmpdir(), 'cc-git-empty-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: emptyRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: emptyRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: emptyRoot, stdio: 'ignore' });
    writeFileSync(join(emptyRoot, '.serenity'), 'test-git-empty');

    const result = await callGit({ subcommand: 'log' }, emptyRoot);
    // "git log" on a repo with no commits fails — should return friendly message
    expect(result).toContain('no commits');

    rmSync(emptyRoot, { recursive: true, force: true });
  });
});

describe('cc-git tool — pull', () => {
  let root: string;

  beforeEach(() => { root = createSerenityInstance(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('throws when no remote configured', async () => {
    await expect(
      callGit({ subcommand: 'pull' }, root),
    ).rejects.toThrow('no remote configured');
  });

  it('pulls successfully from remote (fast-forward)', async () => {
    // Simulate "remote ahead" by using a bare repo:
    const barePath = mkdtempSync(join(tmpdir(), 'cc-git-pull-remote-'));
    execFileSync('git', ['init', '--bare'], { cwd: barePath, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', barePath], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: root, stdio: 'ignore' });

    // Second repo advances the remote
    const clonePath = mkdtempSync(join(tmpdir(), 'cc-git-pull-clone-'));
    execFileSync('git', ['clone', barePath, clonePath], { stdio: 'ignore' });
    writeFileSync(join(clonePath, 'ahead-file.txt'), 'ahead');
    execFileSync('git', ['add', '-A'], { cwd: clonePath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'ahead commit'], { cwd: clonePath, stdio: 'ignore' });
    execFileSync('git', ['push'], { cwd: clonePath, stdio: 'ignore' });

    const result = await callGit({ subcommand: 'pull' }, root);
    expect(result).toBeTruthy();
    expect(result).not.toMatch(/^\[REJECTED\]/);

    rmSync(barePath, { recursive: true, force: true });
    rmSync(clonePath, { recursive: true, force: true });
  });

  it('already up to date', async () => {
    const barePath = mkdtempSync(join(tmpdir(), 'cc-git-pull-remote2-'));
    execFileSync('git', ['init', '--bare'], { cwd: barePath, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', barePath], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: root, stdio: 'ignore' });

    const result = await callGit({ subcommand: 'pull' }, root);
    expect(result).toContain('Already up to date');

    rmSync(barePath, { recursive: true, force: true });
  });
});

describe('cc-git tool — edge cases', () => {
  it('throws when not in a CCC (no .serenity)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-git-no-ccc-'));
    await expect(
      callGit({ subcommand: 'status' }, root),
    ).rejects.toThrow('No CCC found');
    rmSync(root, { recursive: true, force: true });
  });

  it('throws on unknown subcommand', async () => {
    const root = createSerenityInstance();
    await expect(
      callGit({ subcommand: 'garbage' as any }, root),
    ).rejects.toThrow();
    rmSync(root, { recursive: true, force: true });
  });
});
