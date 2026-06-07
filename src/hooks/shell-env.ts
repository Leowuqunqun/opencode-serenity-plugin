/**
 * Shell Environment Hook 工厂
 *
 * 包含：shell.env hook
 * 职责（v0.1 增强）：
 * - 注入 HOME_SERENITY_ROOT = state.cwdRoot（所有 bash 子进程可见）
 * - 注入 SERENITY_INSTANCE = state.instanceName
 * - 注入 SERENITY_PLUGIN_VERSION（plugin 自报版本，便于 msm 脚本判定）
 *
 * 注意：v0 禁 bash（同名 tool 覆盖 + permission.bash=deny），
 *      shell.env 仍生效到 msm_exec 子进程 + 用户终端（如 msm 间接调 bash）
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
  output.env.HOME_SERENITY_ROOT = state.cwdRoot;
  output.env.SERENITY_INSTANCE = state.instanceName;
  // v1.18 统一：与 tui.ts 同源 (package.json#version)，release 时改一处
  output.env.SERENITY_PLUGIN_VERSION = pkg.version;
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
