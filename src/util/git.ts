/**
 * Git 工具 — RR6 验证 + git root 查找
 *
 * 严格使用 SDK 提供的 `input.$` (BunShell) — 不调 git 二进制以保证一致性
 * 注：v0 实际测试中发现 input.$ 是 BunShell，与 POSIX shell 有差异
 * v0 改用 spawn git 二进制（通过 node:child_process），更可靠
 */

import { execFileSync } from 'node:child_process';
import { NotInGitRepoError } from '../errors.js';

/**
 * 从任意 cwd 出发，向上 walk 找到 git root（git rev-parse --show-toplevel）
 * @throws NotInGitRepoError 如果不在 git repo 内
 */
export function findGitRoot(cwd: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    throw new NotInGitRepoError(cwd);
  }
}

/**
 * 同 findGitRoot，但不在 git repo 时返回 null 而非抛错
 * 给 bin/opencode-serenity-plugin.js 用（不抛错便于分支处理）
 */
export function tryFindGitRoot(cwd: string): string | null {
  try {
    return findGitRoot(cwd);
  } catch {
    return null;
  }
}

/**
 * 判断 childPath 是否在 parentPath 内（路径前缀比较）
 * - 规范化路径（resolve）
 * - 用 path.relative 算相对路径
 * - 相对路径不以 '..' 开头 = 在内部
 */
export function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = parentPath.replace(/\/+$/, '');
  const child = childPath.startsWith('/') ? childPath : `/${childPath}`;
  // 简单前缀比较（已规范化的绝对路径）
  if (parent === '/') return child.startsWith('/');
  return child === parent || child.startsWith(parent + '/');
}

/** git init -b main（用于自动初始化非 git 目录） */
export function gitInit(cwd: string): void {
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
    // 设置 user identity（git config），否则 commit 会失败
    execFileSync('git', ['config', 'user.email', 'serenity@ccc.local'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Serenity CCC'], { cwd, stdio: 'ignore' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`git init failed: ${reason}`);
  }
}

/** git repo 是否是干净的（用于 RR7 init 前的 sanity check） */
export function isGitClean(cwd: string): boolean {
  try {
    execFileSync('git', ['diff-index', '--quiet', 'HEAD', '--'], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** git add + commit（用于 RR7） */
export function gitAddAndCommit(cwd: string, file: string, message: string): void {
  try {
    execFileSync('git', ['add', file], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', message], { cwd, stdio: 'ignore' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`git add+commit failed: ${reason}`);
  }
}
