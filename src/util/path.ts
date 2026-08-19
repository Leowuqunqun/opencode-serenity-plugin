/**
 * 路径工具
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SkillNotFoundError } from '../errors.js';

/** 拼出 SKILL.md 绝对路径 */
export function buildSkillPath(cwdRoot: string, cccName: string): string {
  return join(cwdRoot, '.opencode', 'skills', cccName, 'SKILL.md');
}

/** 验证 SKILL.md 存在（RR2） */
export function validateSkillExists(skillPath: string, cwdRoot: string, cccName: string): void {
  if (!existsSync(skillPath)) {
    throw new SkillNotFoundError(cwdRoot, cccName);
  }
}

/** kebab-case 校验（CCC 名只允许小写字母+数字+连字符） */
export function isValidCccName(name: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
}

/**
 * 判断 real 是否是 abs 的"系统级路径别名"（macOS 系统符号链接）。
 *
 * macOS 上 /var、/tmp、/etc 是 /private/var、/private/tmp、/private/etc 的
 * 系统级符号链接，realpathSync 会解析出 /private 前缀。这类别名不是用户
 * 创建的 symlink 攻击，不应被 symlink 防护拦截。
 *
 * 识别方法：abs 以 /var、/tmp、/etc 开头，且 real 是其在 /private 下的
 * 对应展开（或反过来）。无法识别为系统别名 → 返回 false（按攻击处理）。
 */
export function isSystemPathAlias(abs: string, real: string): boolean {
  const systemLinks: Array<[string, string]> = [
    ['/var', '/private/var'],
    ['/tmp', '/private/tmp'],
    ['/etc', '/private/etc'],
  ];
  for (const [alias, target] of systemLinks) {
    if (abs.startsWith(alias + '/') && real.startsWith(target + '/')) {
      const absRest = abs.slice(alias.length);
      const realRest = real.slice(target.length);
      return absRest === realRest;
    }
    // 反向：abs 已是 /private 展开，real 是别名（不常见但防御）
    if (abs.startsWith(target + '/') && real.startsWith(alias + '/')) {
      const absRest = abs.slice(target.length);
      const realRest = real.slice(alias.length);
      return absRest === realRest;
    }
  }
  return false;
}
