/**
 * resolve-path.ts — 宁静号文件系统基础设施
 *
 * 核心能力：
 * - 向上遍历寻找 .serenity 文件（CCC 根检测）
 * - 基于 CCC 根做路径解析
 * - 路径安全校验（确保在根内）
 *
 * 供 file-system-tool.ts 消费，也可被其他模块复用。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, dirname, normalize } from 'node:path';

/**
 * findSerenityRoot — 从 cwd 开始向上遍历，寻找包含 .serenity 文件的目录
 *
 * @param cwd 起始目录（通常是 opencode 的 input.directory）
 * @returns 包含 .serenity 的目录绝对路径
 * @throws Error 如果未找到宁静号根
 */
export function findSerenityRoot(cwd: string): string {
  let current = resolve(cwd);

  // 向上遍历到根
  while (true) {
    const marker = resolve(current, '.serenity');
    if (existsSync(marker) && statSync(marker).isFile()) {
      return current;
    }
    // 到达根目录
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `No CCC found: no .serenity file found when walking up from "${cwd}"`,
      );
    }
    current = parent;
  }
}

/**
 * findSerenityRootSafe — 不抛错版本
 * @returns 根路径或 null（未找到时）
 */
export function findSerenityRootSafe(cwd: string): string | null {
  try {
    return findSerenityRoot(cwd);
  } catch {
    return null;
  }
}

/**
 * readSerenityCccName — 从 .serenity 文件读取 CCC 名
 * @returns CCC 名（如 "home-serenity", "tg-serenity"）或 null
 */
export function readSerenityCccName(root: string): string | null {
  const marker = resolve(root, '.serenity');
  try {
    const content = readFileSync(marker, 'utf8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * resolveRootPath — 将 path 基于宁静号根解析为绝对路径
 *
 * @param root CCC 根路径
 * @param path 相对路径（如 "AGENT_SESSIONS/"）或绝对路径
 * @returns 解析后的绝对路径
 */
export function resolveRootPath(root: string, path: string): string {
  if (path.startsWith('/')) {
    return normalize(path);
  }
  return normalize(resolve(root, path));
}

/**
 * isPathInsideSerenity — 判断路径是否在宁静号根内
 *
 * @param root CCC 根路径
 * @param target 要检查的路径（绝对路径）
 * @returns true 当 target 在 root 目录内
 */
export function isPathInsideSerenity(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !rel.startsWith('..');
}

/**
 * serenityPathRelative — 获取 target 相对于宁静号根的路径
 *
 * @param root CCC 根路径
 * @param target 绝对路径
 * @returns 相对路径（如 ".opencode/skills/eap/SKILL.md"）
 */
export function serenityPathRelative(root: string, target: string): string {
  const rel = relative(root, target);
  if (rel.startsWith('..')) {
    throw new Error(`Path "${target}" is outside serenity root "${root}"`);
  }
  return rel;
}
