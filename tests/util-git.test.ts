/**
 * git 工具单测
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPathInside, findGitRoot } from '../src/util/git.js';
import { NotInGitRepoError } from '../src/errors.js';

describe('util/git', () => {
  it('isPathInside 判定子路径', () => {
    expect(isPathInside('/root', '/root/foo')).toBe(true);
    expect(isPathInside('/root', '/root/foo/bar')).toBe(true);
    expect(isPathInside('/root', '/root')).toBe(true);
    expect(isPathInside('/root', '/other')).toBe(false);
    expect(isPathInside('/root', '/root-other')).toBe(false);
    expect(isPathInside('/', '/anything')).toBe(true);
  });

  it('findGitRoot 找真实 git repo', () => {
    // 当前仓（plugin 仓）就是 git repo
    const root = findGitRoot(process.cwd());
    expect(root).toBeTruthy();
    expect(root).toMatch(/opencode-serenity-plugin$/);
  });

  it('findGitRoot 在非 git 目录抛 NotInGitRepoError', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-nogit-'));
    expect(() => findGitRoot(tmp)).toThrow(NotInGitRepoError);
  });

  it('在临时 git repo 中也能找到 root', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'serenity-git-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
    writeFileSync(join(tmp, 'a.txt'), 'a');
    execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp, stdio: 'ignore' });
    expect(findGitRoot(tmp)).toBe(tmp);
  });
});
