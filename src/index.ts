/**
 * opencode-serenity-plugin — v0.1 入口（两阶段 init + hook 工厂分层）
 *
 * 启动协议见 architecture-v0.md
 * 契约见 contract-v0.md
 * 范围层见 docs/requirements-v0-scope.md（RR1-RR7）
 * v0.1 变更见 docs/v0.1-candidates.md（候选 1：两阶段 init / 候选 3：hook 工厂分层）
 *
 * Hook 工厂分层（v0.1-3）：
 * - createPermissionGuards：tool.execute.before（RR3 bash 防御 + RR5 路径守卫）
 * - createCompactingHooks：system.transform（RR3/RR7 提示）+ session.compacting（关键状态注入）
 * - createShellEnv：shell.env（HOME_SERENITY_ROOT + SERENITY_INSTANCE 注入）
 */

import type { Plugin, Hooks } from '@opencode-ai/plugin';
import { tryActivateSync } from './activation.js';
import { msmListTool, msmExecTool } from './msm.js';
import { bashOverrideTool } from './bash-override.js';
import { createPermissionGuards } from './hooks/permission-guards.js';
import { createCompactingHooks } from './hooks/compacting.js';
import { createShellEnv } from './hooks/shell-env.js';

const plugin: Plugin = async (input) => {
  // Phase 1: 同步 RR6 验证（git repo）
  const syncResult = tryActivateSync(input);

  if (!syncResult.ok) {
    // 不激活 = "就像没装一样" —— 不抛错（会中断 opencode 启动），返回空 Hooks
    // eslint-disable-next-line no-console
    console.warn(`[serenity-plugin] not activated: ${syncResult.reason}`);
    return {};
  }

  // Phase 2 启动：fire-and-forget，状态机后台验证 RR1 + RR2
  // （由 activation.activateAsync 内部触发，此处不 await）

  // 注册 hooks + tools（Phase 2 未完成时 hook 内 await ensureReady() 阻塞）
  const hooks: Hooks = {
    tool: {
      bash: bashOverrideTool, // 同名覆盖（RR3 第三层）
      msm_list: msmListTool,
      msm_exec: msmExecTool,
    },
    ...createPermissionGuards(),
    ...createCompactingHooks(),
    ...createShellEnv(),
  };

  // eslint-disable-next-line no-console
  console.log(
    `[serenity-plugin] phase 1 ok: cwdRoot="${syncResult.cwdRoot}"; phase 2 loading in background`,
  );
  return hooks;
};

export default plugin;

// 保留旧 export 兼容（tests 用）
export { isActive } from './state.js';
