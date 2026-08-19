/**
 * MSM flag 规范解析 + path-arg 校验（v1.2 修复）
 *
 * 设计目标：让 plugin 兼容 **两种 msm schema**：
 *
 * **v1 schema**（主仓实际使用）：
 *   ```json
 *   flags: [{ "flag": "--check <路径>", "description": "..." }]
 *   ```
 *   - 字段是 `flag`（含 `--` 整字符串）
 *   - 路径型用 valueHint `<路径>` / `<path>` 标记
 *   - 无 type 字段
 *
 * **v0 schema**（plugin 仓设计）：
 *   ```json
 *   flags: [{ "name": "check", "type": "path", "description": "..." }]
 *   ```
 *
 * 输出统一 NormalizedFlag[]：
 *   - name: 'check'（不带 `--`）
 *   - hasValue: boolean
 *   - valueHint: '路径'（v1 schema 提取）
 *   - isPath: boolean
 *
 * 校验流程：
 * 1. CLI args 字符串 → tokenize（支持引号）
 * 2. token pair `--flag value` → 查 normalizeFlags 找 isPath 标记
 * 3. 路径型 → isPathInside 黑名单 + symlink 防御
 */

import { resolve as resolvePath } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { isPathInside } from './util/git.js';
import { isSystemPathAlias } from './util/path.js';
import { MsmPathEscapeError, MsmSymlinkError } from './errors.js';

/** 原始 flag 字段（v1 schema 用 `flag`，v0 schema 用 `name`） */
type RawFlag = {
  flag?: string;
  name?: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
};

/** 规范化后的 flag（plugin 内部统一使用） */
export type NormalizedFlag = {
  name: string;
  hasValue: boolean;
  valueHint: string | undefined;
  isPath: boolean;
  type: string | undefined;
  required: boolean;
};

/** v1 schema 的 valueHint 视为"路径型" */
const PATH_VALUE_HINTS: ReadonlySet<string> = new Set([
  '路径',
  'path',
  'file',
  'filePath',
  'filepath',
  'dir',
  'directory',
  '文件',
  '目录',
  'url',
  'uri',
]);

/** v0 schema 的 type 视为"路径型" */
const PATH_ARG_TYPES: ReadonlySet<string> = new Set([
  'path',
  'file',
  'filePath',
  'filepath',
  'dir',
  'directory',
]);

/** v1 schema flag 字符串 → {name, hasValue, valueHint} */
function parseV1Flag(flagStr: string): { name: string; hasValue: boolean; valueHint: string | undefined } {
  const m = /^--([\w-]+)(?:[=\s]+(?:<(.+?)>))?$/.exec(flagStr.trim());
  if (!m) {
    return { name: flagStr, hasValue: false, valueHint: undefined };
  }
  return {
    name: m[1]!,
    hasValue: m[2] !== undefined,
    valueHint: m[2],
  };
}

/** 规范化单个 flag（兼容 v0 / v1 schema） */
export function normalizeFlag(raw: RawFlag): NormalizedFlag | null {
  if (typeof raw.name === 'string') {
    const type = raw.type;
    return {
      name: raw.name,
      hasValue: type !== 'boolean',
      valueHint: undefined,
      isPath: type !== undefined && PATH_ARG_TYPES.has(type),
      type,
      required: raw.required ?? false,
    };
  }
  if (typeof raw.flag === 'string') {
    const parsed = parseV1Flag(raw.flag);
    return {
      name: parsed.name,
      hasValue: parsed.hasValue,
      valueHint: parsed.valueHint,
      isPath: parsed.valueHint !== undefined && PATH_VALUE_HINTS.has(parsed.valueHint),
      type: undefined,
      required: false,
    };
  }
  return null;
}

/** 批量规范化 */
export function normalizeFlags(rawFlags: RawFlag[]): NormalizedFlag[] {
  const out: NormalizedFlag[] = [];
  for (const raw of rawFlags) {
    const norm = normalizeFlag(raw);
    if (norm !== null) out.push(norm);
  }
  return out;
}

/** 从 normalized flags 提取所有 path-arg 名字 */
export function getPathArgNames(normalized: NormalizedFlag[]): string[] {
  return normalized.filter((f) => f.isPath).map((f) => f.name);
}

/* ===== CLI tokenize + path-arg 校验（v1.2 简化为启发式） ===== */

/**
 * 轻量 shell tokenize（支持单/双引号 + 转义）。
 * 不支持 glob / 变量展开（msm 脚本不需要）。
 * 示例：
 *   '--check .opencode/x' → ['--check', '.opencode/x']
 *   '--name "hello world"' → ['--name', 'hello world']
 *   '--root' → ['--root']
 */
export function tokenizeArgs(args: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (c === '\\' && i + 1 < args.length) {
      cur += args[i + 1]!;
      i++;
      hasToken = true;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      hasToken = true;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      hasToken = true;
      continue;
    }
    if (/\s/.test(c) && !inSingle && !inDouble) {
      if (hasToken) {
        out.push(cur);
        cur = '';
        hasToken = false;
      }
      continue;
    }
    cur += c;
    hasToken = true;
  }
  if (hasToken) out.push(cur);
  return out;
}

/**
 * 校验 tokenized CLI args 中的 path-arg。
 * 启发式：解析 `--flag value` / `--flag=value` 形式，对 valueHint 标为 path 的 flag 做 isPathInside 检查。
 *
 * 行为细节：
 * - 非 path-arg 不校验
 * - token 顺序解析，--flag 后面跟的 token 是 value
 * - = 形式 --flag=value 也校验
 * - 文件不存在（写文件场景）→ 通过
 * - symlink 防御
 */
export function validatePathArgsFromTokens(
  tokens: string[],
  normalized: NormalizedFlag[],
  cwdRoot: string,
): void {
  // path-arg names 集合
  const pathArgNames = new Set(getPathArgNames(normalized));

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    // 匹配 --flag 或 --flag=value
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(tok);
    if (!m) continue;
    const flagName = m[1]!;
    if (!pathArgNames.has(flagName)) continue;
    // 取值：--flag=value 行内取，否则取下个 token
    let value: string | undefined = m[2];
    if (value === undefined) {
      value = tokens[i + 1];
      if (value === undefined || value.startsWith('--')) continue;
    }
    if (typeof value !== 'string' || value.trim() === '') continue;

    const abs = resolvePath(cwdRoot, value);
    if (!isPathInside(cwdRoot, abs)) {
      throw new MsmPathEscapeError('msm_exec', flagName, value, abs);
    }

    if (existsSync(abs)) {
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        throw new MsmSymlinkError('msm_exec', flagName, value, abs, 'realpath resolution failed');
      }
      // 2026-08-19: 修复 macOS /var → /private/var 系统符号链接误判。
      // 原逻辑 real !== abs 即判 symlink，但 macOS 的 /var、/tmp 等是系统级
      // 符号链接，realpath 后会带 /private 前缀，导致所有 /var 下路径误报。
      // 方案：仅当 real 与 abs 不同时，判断是否为"系统级前缀别名"——
      //   系统别名：real 的父级目录是系统路径（/var→/private/var, /tmp→/private/tmp,
      //              /etc→/private/etc 等），且 real 仍在容器内 → 放行
      //   用户 symlink：real 与 abs 不同且非系统别名 → 仍按原逻辑 throw（保持严格）
      if (real !== abs) {
        const isSystemAlias = isSystemPathAlias(abs, real);
        if (!isSystemAlias) {
          throw new MsmSymlinkError('msm_exec', flagName, value, abs, `symlink detected: ${abs} → ${real}`);
        }
      }
      // 边界检查：real 必须仍在容器内（用归一化后的 rootReal 比较）
      let rootReal = cwdRoot;
      try {
        rootReal = realpathSync(cwdRoot);
      } catch {
        rootReal = cwdRoot; // cwdRoot 不存在时回退
      }
      if (!isPathInside(rootReal, real)) {
        throw new MsmSymlinkError('msm_exec', flagName, value, abs, `symlink points outside cwdRoot: ${real}`);
      }
    }
  }
}
