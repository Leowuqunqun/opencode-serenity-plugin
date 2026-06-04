/**
 * 10 步启动协议 — RR1 + RR2 + RR6 验证
 *
 * 流程：
 * 1. plugin 入口收到 input
 * 2. cwd = process.cwd()（input.directory）
 * 3. 检查 cwd 是否在 git repo（RR6）→ 否：不激活
 * 4. 在 cwd 根检查 /.serenity（RR1）→ 不存在：不激活
 * 5. 读取 /.serenity → 实例名 N
 * 6. 定位 .opencode/skills/<N>/SKILL.md（RR2）→ 找不到：不激活
 * 7. 缓存激活状态
 * 8-10 由 plugin 入口在调用此函数后做（注册 hooks/tools）
 *
 * 重要：此函数不抛错；不满足条件时返回 INACTIVE_STATE 即可
 */

import { findGitRoot } from './util/git.js';
import { readSerenityFile } from './util/serenity-file.js';
import { buildSkillPath, validateSkillExists } from './util/path.js';
import type { SerenityState } from './types/index.js';
import { setState } from './state.js';
import type { PluginInput } from '@opencode-ai/plugin';

export type ActivationResult =
  | { ok: true; state: SerenityState }
  | { ok: false; reason: string };

/**
 * 尝试激活 plugin。
 * 不抛错——所有失败路径返回 { ok: false, reason }
 * 成功路径会**顺便**写入全局 state（state.ts singleton）
 */
export function tryActivate(input: PluginInput): ActivationResult {
  const cwd = input.directory;
  let cwdRoot: string;
  let instanceName: string;
  let skillPath: string;

  // 步骤 2-3: 找 git root（RR6）
  try {
    cwdRoot = findGitRoot(cwd);
  } catch (err) {
    return { ok: false, reason: errMsg(err, 'RR6: cwd not in git repo') };
  }

  // 步骤 4-5: 读 /.serenity（RR1）
  try {
    instanceName = readSerenityFile(cwdRoot);
  } catch (err) {
    return { ok: false, reason: errMsg(err, 'RR1: /.serenity not found or invalid') };
  }

  // 步骤 6: 定位 SKILL.md（RR2）
  try {
    skillPath = buildSkillPath(cwdRoot, instanceName);
    validateSkillExists(skillPath, cwdRoot, instanceName);
  } catch (err) {
    return { ok: false, reason: errMsg(err, 'RR2: instance skill not found') };
  }

  // 步骤 7: 缓存激活状态
  const state: SerenityState = Object.freeze({
    activated: true,
    cwdRoot,
    instanceName,
    skillPath,
  });
  setState(state);
  return { ok: true, state };
}

function errMsg(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
