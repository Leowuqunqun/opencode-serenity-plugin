/**
 * RR7 init — slash command `/serenity-init` 业务逻辑
 *
 * v1.10：把"非 serenity 目录无法被 plugin 识别"的死循环打破。
 * 触发：TUI slash command onSelect → DialogPrompt → onConfirm → initSerenity
 *
 * 设计约束（RR7 spec §5 失败矩阵）：
 * - prefix 不合法 → throw InvalidCccNameError
 * - cwd 不在 git repo → throw NotInGitRepoError（透传 findGitRoot）
 * - /.serenity 已存在 → return { kind: 'already', name }（不覆盖）
 * - git add/commit 失败 → rollback 写文件 + throw InitGitCommitError
 *
 * 与 util/serenity-file.ts 协作：
 * - serenityFileExists 探测 / writeSerenityFile 落盘 / removeSerenityFile rollback
 * - readSerenityFile 用于 "already" 路径回读现有实例名
 */

import { findGitRoot, gitAddAndCommit } from './git.js';
import {
  serenityFileExists,
  writeSerenityFile,
  removeSerenityFile,
  readSerenityFile,
} from './serenity-file.js';
import {
  InvalidCccNameError,
  InitGitCommitError,
} from '../errors.js';

/** v1.10 RR7 命名模型：所有 CCC 名都带 -serenity 后缀 */
export const SERENITY_SUFFIX = '-serenity';

/** 拼 CCC 名 = `${prefix}-serenity` */
export function buildCccName(prefix: string): string {
  return `${prefix}${SERENITY_SUFFIX}`;
}

/**
 * 验证 prefix 是合法 kebab-case（同 cccName 规则）。
 * 独立函数（不委托 isValidCccName）以保持语义清晰。
 */
export function isValidPrefix(prefix: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(prefix);
}

/**
 * 智能默认 prefix（见设计文档 §3 表格）：
 * 1. lowercase
 * 2. 非 [a-z0-9] 字符 → '-'
 * 3. 折叠多 '-'、去首尾 '-'
 * 4. 若结果以 '-serenity' 结尾且剩余 prefix 合法 → 剥后缀
 *
 * 边界 case：
 * - 空字符串 → ''（无字符可剥，保持空）
 * - '---serenity' → ''（剥后缀后空）
 * - 'tg-serenity' → 'tg'
 * - 'myproject' → 'myproject'（无 -serenity 后缀）
 */
export function defaultPrefix(dirName: string): string {
  const kebab = dirName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (kebab === '') return '';
  if (kebab.endsWith(SERENITY_SUFFIX)) {
    const stripped = kebab.slice(0, -SERENITY_SUFFIX.length);
    if (isValidPrefix(stripped)) return stripped;
  }
  return kebab;
}

export type InitResult =
  | { kind: 'created'; name: string }
  | { kind: 'already'; name: string };

/**
 * 初始化 cwd 为 serenity 实例（RR7）。
 * @throws InvalidInstanceNameError prefix 不是 kebab-case
 * @throws NotInGitRepoError cwd 不在 git repo（透传 findGitRoot）
 * @throws InitGitCommitError git add/commit 失败（已 rollback 写文件）
 */
export async function initSerenity(cwd: string, prefix: string): Promise<InitResult> {
  if (!isValidPrefix(prefix)) {
    throw new InvalidCccNameError(prefix);
  }

  const gitRoot = findGitRoot(cwd);

  if (serenityFileExists(gitRoot)) {
    const name = readSerenityFile(gitRoot);
    return { kind: 'already', name };
  }

  const name = buildCccName(prefix);
  writeSerenityFile(gitRoot, name);

  try {
    gitAddAndCommit(gitRoot, '.serenity', `chore: init serenity (${name})`);
  } catch (err) {
    removeSerenityFile(gitRoot);
    const reason = err instanceof Error ? err.message : String(err);
    throw new InitGitCommitError(reason);
  }

  return { kind: 'created', name };
}
