/**
 * 路径工具
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SkillNotFoundError } from '../errors.js';

/** 拼出 SKILL.md 绝对路径 */
export function buildSkillPath(cwdRoot: string, instanceName: string): string {
  return join(cwdRoot, '.opencode', 'skills', instanceName, 'SKILL.md');
}

/** 验证 SKILL.md 存在（RR2） */
export function validateSkillExists(skillPath: string, cwdRoot: string, instanceName: string): void {
  if (!existsSync(skillPath)) {
    throw new SkillNotFoundError(cwdRoot, instanceName);
  }
}

/** kebab-case 校验（实例名只允许小写字母+数字+连字符） */
export function isValidInstanceName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}
