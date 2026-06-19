/**
 * util/init 单测 — RR7 slash command 业务逻辑
 *
 * v1.10: defaultPrefix / buildCccName / isValidPrefix / initSerenity
 *
 * initSerenity 涉及真实 git 操作（git init / git add / git commit），
 * 所以用例在 mkdtemp 创建的临时 git repo 里跑，测完 rm -rf 清理。
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCccName,
  defaultPrefix,
  initSerenity,
  isValidPrefix,
  SERENITY_SUFFIX,
} from '../src/util/init.js';
import { writeSerenityFile } from '../src/util/serenity-file.js';
import {
  InitGitCommitError,
  InvalidCccNameError,
  NotInGitRepoError,
} from '../src/errors.js';

/** 创建一个空的 git repo（含 user.email / user.name 以便 commit）*/
function setupGitRepo(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'init-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
  return tmp;
}

function cleanup(tmp: string): void {
  rmSync(tmp, { recursive: true, force: true });
}

// 用 readFileSync 直接读（避开 readSerenityFile 的 empty-throw 分支）
function readSerenityFileOrFail(cwdRoot: string): string {
  return readFileSync(join(cwdRoot, '.serenity'), 'utf8').trim();
}

function fileExists(cwdRoot: string, name: string): boolean {
  return existsSync(join(cwdRoot, name));
}

describe('defaultPrefix', () => {
  it('MyProject → myproject', () => {
    expect(defaultPrefix('MyProject')).toBe('myproject');
  });

  it('My Cool App → my-cool-app', () => {
    expect(defaultPrefix('My Cool App')).toBe('my-cool-app');
  });

  it('tg-serenity → tg（剥后缀）', () => {
    expect(defaultPrefix('tg-serenity')).toBe('tg');
  });

  it('xx-serenity → xx（剥后缀）', () => {
    expect(defaultPrefix('xx-serenity')).toBe('xx');
  });

  it('My_Project → my-project', () => {
    expect(defaultPrefix('My_Project')).toBe('my-project');
  });

  it('"  spaces  " → spaces（trim + collapse）', () => {
    expect(defaultPrefix('  spaces  ')).toBe('spaces');
  });

  it('空字符串 → 空字符串', () => {
    expect(defaultPrefix('')).toBe('');
  });
});

describe('buildCccName', () => {
  it('xx → xx-serenity', () => {
    expect(buildCccName('xx')).toBe('xx-serenity');
  });

  it('my-cool → my-cool-serenity', () => {
    expect(buildCccName('my-cool')).toBe('my-cool-serenity');
  });

  it('SERENITY_SUFFIX = "-serenity"', () => {
    expect(SERENITY_SUFFIX).toBe('-serenity');
  });
});

describe('isValidPrefix', () => {
  it('xx → true', () => {
    expect(isValidPrefix('xx')).toBe(true);
  });

  it('my-cool-app → true', () => {
    expect(isValidPrefix('my-cool-app')).toBe(true);
  });

  it('MyProject → false（大写）', () => {
    expect(isValidPrefix('MyProject')).toBe(false);
  });

  it('-xx → false（前导 dash）', () => {
    expect(isValidPrefix('-xx')).toBe(false);
  });

  it('xx- → false（尾随 dash）', () => {
    expect(isValidPrefix('xx-')).toBe(false);
  });

  it('空字符串 → false', () => {
    expect(isValidPrefix('')).toBe(false);
  });
});

describe('initSerenity', () => {
  it('happy path: 写文件 + git commit', async () => {
    const tmp = setupGitRepo();
    try {
      const result = await initSerenity(tmp, 'xx');
      expect(result.kind).toBe('created');
      if (result.kind === 'created') {
        expect(result.name).toBe('xx-serenity');
      }
      expect(readSerenityFileOrFail(tmp)).toBe('xx-serenity');
      const commitLog = execFileSync('git', ['log', '--oneline'], { cwd: tmp, encoding: 'utf-8' });
      const commits = commitLog.trim().split('\n').filter(Boolean);
      expect(commits).toHaveLength(1);
      expect(commits[0]).toContain('init serenity');
      expect(commits[0]).toContain('xx-serenity');
    } finally {
      cleanup(tmp);
    }
  });

  it('already: 不写不提交，返回 { kind: "already", name }', async () => {
    const tmp = setupGitRepo();
    try {
      writeSerenityFile(tmp, 'existing-serenity');
      execFileSync('git', ['add', '.serenity'], { cwd: tmp, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmp, stdio: 'ignore' });

      const result = await initSerenity(tmp, 'xx');
      expect(result.kind).toBe('already');
      if (result.kind === 'already') {
        expect(result.name).toBe('existing-serenity');
      }
      const commitLog = execFileSync('git', ['log', '--oneline'], { cwd: tmp, encoding: 'utf-8' });
      const commits = commitLog.trim().split('\n').filter(Boolean);
      expect(commits).toHaveLength(1);
      expect(readSerenityFileOrFail(tmp)).toBe('existing-serenity');
    } finally {
      cleanup(tmp);
    }
  });

  it('invalid prefix → throws InvalidCccNameError', async () => {
    const tmp = setupGitRepo();
    try {
      await expect(initSerenity(tmp, 'MyProject')).rejects.toThrow(InvalidCccNameError);
      expect(fileExists(tmp, '.serenity')).toBe(false);
    } finally {
      cleanup(tmp);
    }
  });

  it('not in git repo → auto git init + create (v0.4 auto-init)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'init-autogit-'));
    try {
      const result = await initSerenity(tmp, 'xx');
      expect(result.kind).toBe('created');
      if (result.kind === 'created') {
        expect(result.name).toBe('xx-serenity');
      }
      // 验证 git repo 已创建
      const gitDir = join(tmp, '.git');
      expect(existsSync(gitDir)).toBe(true);
      // 验证 .serenity 已写入
      expect(readSerenityFileOrFail(tmp)).toBe('xx-serenity');
      // 验证 git commit 已生成
      const commitLog = execFileSync('git', ['log', '--oneline'], { cwd: tmp, encoding: 'utf-8' });
      const commits = commitLog.trim().split('\n').filter(Boolean);
      expect(commits).toHaveLength(1);
      expect(commits[0]).toContain('init serenity');
    } finally {
      cleanup(tmp);
    }
  });

  it('InitGitCommitError 存在（import sanity check）', () => {
    const e = new InitGitCommitError('reason');
    expect(e.name).toBe('InitGitCommitError');
  });
});
