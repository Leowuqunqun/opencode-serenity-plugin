/**
 * Shell Environment Hook 工厂
 *
 * 包含：shell.env hook
 * 职责（v0.2 ACC/CCC 对齐）：
 * - 注入 SERENITY_ROOT = state.cwdRoot（所有 bash 子进程可见，旧名 HOME_SERENITY_ROOT 保留 deprecated）
 * - 注入 SERENITY_CCC = state.cccName（旧名 SERENITY_INSTANCE 保留 deprecated）
 * - 注入 SERENITY_VERSION = pkg.version（旧名 SERENITY_PLUGIN_VERSION 保留 deprecated）
 *
 * 注意：bash 是高风险 fallback（D19）；msm_exec 为默认执行路径，
 *      shell.env 仍生效到 msm_exec 子进程 + 用户终端。
 */

import type { Hooks } from '@opencode-ai/plugin';
import { getState, ensureReady } from '../state.js';
import { safeCreateHook, type HookConfig } from './util.js';
import pkg from '../../package.json' with { type: 'json' };

const shellEnvImpl: NonNullable<Hooks['shell.env']> = async (_input, output) => {
  try {
    await ensureReady();
  } catch {
    return;
  }

  const state = getState();
  output.env.SERENITY_ROOT = state.cwdRoot;
  output.env.HOME_SERENITY_ROOT = state.cwdRoot;   // deprecated alias
  output.env.SERENITY_CCC = state.cccName;
  output.env.SERENITY_INSTANCE = state.cccName;     // deprecated alias
  output.env.SERENITY_VERSION = pkg.version;
  output.env.SERENITY_PLUGIN_VERSION = pkg.version; // deprecated alias
};

/** 工厂：返回 shell env 相关的 hooks 集合
 *
 * v1.12: 改用 safeCreateHook（factory pattern）
 */
export function createShellEnv(config?: HookConfig): Partial<Hooks> {
  const hooks: Partial<Hooks> = {};
  hooks['shell.env'] = safeCreateHook(
    'shell.env',
    () => shellEnvImpl,
    config,
  );
  return hooks;
}
