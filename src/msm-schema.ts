/**
 * MSM path-arg 预解析 + 路径安全校验（v0.1-2）
 *
 * 设计目标：修复 msm_exec path escape 隐患
 * - msm registry 中 flags[].type === 'path' 视为路径型参数
 * - msm_exec 阶段在调用 msm 前，对所有 path-arg 做 isPathInside(cwdRoot, value) 校验
 * - 失败：throw MsmPathEscapeError（在 msm 子进程启动前）
 *
 * 约定（不修改 registry schema）：
 * - PATH_ARG_TYPES 中列出的字符串视为"路径型"
 * - 兼容 msm 写者的多种命名习惯（path / file / filePath / dir / directory）
 */

import { resolve as resolvePath } from 'node:path';
import { isPathInside } from './util/git.js';
import { MsmPathEscapeError } from './errors.js';

/** 约定：registry flags[].type 为以下值之一 = 路径型参数 */
const PATH_ARG_TYPES: ReadonlySet<string> = new Set([
  'path',
  'file',
  'filePath',
  'filepath',
  'dir',
  'directory',
]);

/** msm registry 单条 entry（从 msm.ts 提取共享类型） */
type MechEntryFlag = {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
};

type MechEntry = {
  name: string;
  path: string;
  skill: string;
  category: 'mech' | 'semi-mech';
  description: string;
  usage: string;
  flags: MechEntryFlag[];
};

/** 从 entry 提取所有 path-arg 名字（按 registry 顺序） */
export function getPathArgNames(entry: MechEntry): string[] {
  return entry.flags
    .filter((f) => PATH_ARG_TYPES.has(f.type))
    .map((f) => f.name);
}

/**
 * 校验 args 中所有 path-arg 都在 cwdRoot 内。
 * 失败：throw MsmPathEscapeError
 *
 * 行为细节：
 * - 非 path-arg 不校验（数字/布尔/普通字符串原样传给 msm）
 * - 缺失的 path-arg 不校验（由 msm 自己的 required 检查处理）
 * - 路径值如果是相对路径，resolve 到 cwdRoot
 * - 如果值是对象/数组，跳过（path-arg 约定是 string）
 */
export function validatePathArgs(
  args: Record<string, unknown>,
  entry: MechEntry,
  cwdRoot: string,
): void {
  const pathArgNames = getPathArgNames(entry);
  for (const name of pathArgNames) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') continue;
    if (value.trim() === '') continue;

    const abs = resolvePath(cwdRoot, value);
    if (!isPathInside(cwdRoot, abs)) {
      throw new MsmPathEscapeError(entry.name, name, value, abs);
    }
  }
}
