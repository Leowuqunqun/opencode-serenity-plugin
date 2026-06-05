/**
 * Compacting / System Transform Hook 工厂
 *
 * 包含：
 * 1. experimental.chat.system.transform — 注入 RR3 / RR7 提示到 system prompt
 * 2. experimental.session.compacting — 压缩时注入"serenity 关键状态" context
 *
 * 设计：
 * - RR3 提示：提醒 LLM bash 已禁用，必须用 msm_list / msm_exec
 * - RR7 提示：/serenity-init 走 msm_exec 而非 bash
 * - compacting 注入：避免 serenity 关键状态（cwdRoot、instanceName、SKILL.md 路径）被压缩丢失
 */

import type { Hooks } from '@opencode-ai/plugin';
import { getState, ensureReady } from '../state.js';
import { isHookEnabled, safeHook, type HookConfig } from './util.js';

const systemTransformImpl: NonNullable<Hooks['experimental.chat.system.transform']> = async (
  _input,
  output,
) => {
  try {
    await ensureReady();
  } catch {
    return;
  }

  output.system.push(
    `[serenity-plugin] \`bash\` tool is disabled (RR3). Use \`msm_list\` to discover MSMs and \`msm_exec\` to invoke. Tool scope is limited to cwd root (RR5).`,
  );

  output.system.push(
    `[serenity-plugin] Available slash commands: \`/serenity-init\` (RR7). ` +
      `When the user types \`/serenity-init\`, do NOT try to execute it via bash. ` +
      `Instead, call \`msm_exec\` with msm_name="serenity-init" and appropriate args. ` +
      `The init script will: create /.serenity in cwd root, then git add + commit it.`,
  );
};

const sessionCompactingImpl: NonNullable<Hooks['experimental.session.compacting']> = async (
  _input,
  output,
) => {
  try {
    await ensureReady();
  } catch {
    return;
  }

  const state = getState();
  output.context.push(
    `[serenity-state] cwdRoot=${state.cwdRoot}; instanceName=${state.instanceName}; skillPath=${state.skillPath}`,
  );
  output.context.push(
    `[serenity-state] RR3: bash disabled, use msm_list/msm_exec. RR5: scope is cwdRoot only. RR7: /serenity-init via msm_exec.`,
  );
};

/** 工厂：返回 compacting / system transform 相关的 hooks 集合 */
export function createCompactingHooks(config?: HookConfig): Partial<Hooks> {
  const hooks: Partial<Hooks> = {};

  if (isHookEnabled('experimental.chat.system.transform', config)) {
    const wrapped = safeHook('experimental.chat.system.transform', systemTransformImpl, config);
    if (wrapped) hooks['experimental.chat.system.transform'] = wrapped;
  }

  if (isHookEnabled('experimental.session.compacting', config)) {
    const wrapped = safeHook('experimental.session.compacting', sessionCompactingImpl, config);
    if (wrapped) hooks['experimental.session.compacting'] = wrapped;
  }

  return hooks;
}
