/**
 * Git 工具 — RR6 验证 + git root 查找
 *
 * 严格使用 SDK 提供的 `input.$` (BunShell) — 不调 git 二进制以保证一致性
 * 注：v0 实际测试中发现 input.$ 是 BunShell，与 POSIX shell 有差异
 * v0 改用 spawn git 二进制（通过 node:child_process），更可靠
 */

import { execFileSync } from 'node:child_process';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
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
 * - 先 resolve 展开 `..`/`.` 等相对成分
 * - 用规范化后的绝对路径做前缀比较
 */
export function isPathInside(parentPath: string, childPath: string): boolean {
  const parent = resolvePath(parentPath).replace(/\/+$/, '');
  const child = resolvePath(childPath);
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

/**
 * 从 cwd 的 .git/config 读取 [remote "origin"] 的 URL，提取 GitHub owner。
 * 用于 git push owner 白名单检测（2026-08-19 放开个人 fork push）。
 *
 * 支持 URL 形式：
 *   - https://github.com/<owner>/<repo>.git
 *   - https://github.com/<owner>/<repo>
 *   - git@github.com:<owner>/<repo>.git
 *   - git@github.com:<owner>/<repo>
 *
 * @param cwd 任意子目录（向上找 .git/config）
 * @returns owner 字符串（如 'Leowuqunqun'）；非 GitHub URL / 无 origin → null
 */
export function readGitHubOwner(cwd: string): string | null {
  try {
    const configPath = findGitConfigPath(cwd);
    if (!configPath) return null;
    const content = readFileSync(configPath, 'utf8');
    // 解析 [remote "origin"] 段的 url
    const remoteSection = content.split(/\[\s*remote\s+"origin"\s*\]/)[1];
    if (!remoteSection) return null;
    const urlLine = remoteSection.split(/\[\s*[a-zA-Z]/)[0]!.match(/url\s*=\s*(.+)/);
    if (!urlLine) return null;
    const url = urlLine[1]!.trim();
    // 提取 GitHub owner
    const m = url.match(/github\.com[:/]([\w.-]+)\//);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

function findGitConfigPath(startDir: string): string | null {
  let current = resolvePath(startDir);
  while (true) {
    const candidate = join(current, '.git', 'config');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * 检查 cwd 的 git origin 是否在白名单 owner 列表中。
 * 仅对 GitHub URL 生效；其他 URL（非 GitHub）一律返回 false。
 *
 * 白名单维护：所有 owner 在此列出。**收紧而非放开**——LLM 永远不能推
 * 官方仓（tellmewhattodo）或任何不在此名单的 owner。
 */
export function isAllowedPushOwner(cwd: string, allowedOwners: readonly string[]): boolean {
  const owner = readGitHubOwner(cwd);
  if (!owner) return false;
  return allowedOwners.includes(owner);
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
