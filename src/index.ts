/**
 * opencode-serenity-plugin — v0.1 入口（两阶段 init）
 *
 * 启动协议见 architecture-v0.md
 * 契约见 contract-v0.md
 * 范围层见 docs/requirements-v0-scope.md（RR1-RR7）
 * v0.1 变更见 docs/v0.1-candidates.md（候选 1：两阶段 init）
 */

import type { Plugin, Hooks } from '@opencode-ai/plugin';
import { tryActivateSync } from './activation.js';
import { msmListTool, msmExecTool } from './msm.js';
import { bashOverrideTool } from './bash-override.js';
import { toolExecuteBeforeHook } from './permission.js';
import { systemTransformHook } from './commands.js';

const plugin: Plugin = async (input) => {
  // 步骤 1-3: 同步 Phase 1（RR6 验证） + 启动 Phase 2 fire-and-forget
  const syncResult = tryActivateSync(input);

  if (!syncResult.ok) {
    // 不激活 = "就像没装一样"
    // 不抛错（抛错会中断 opencode 启动）；返回空 Hooks
    // eslint-disable-next-line no-console
    console.warn(`[serenity-plugin] not activated: ${syncResult.reason}`);
    return {};
  }

  // 步骤 8-10: 注册 hooks + tools（立即生效；Phase 2 后台跑）
  const hooks: Hooks = {
    tool: {
      // 覆盖内置 bash（同名 tool 后注册覆盖前注册，L3 验证）
      bash: bashOverrideTool,
      // 注册 msm_list + msm_exec
      msm_list: msmListTool,
      msm_exec: msmExecTool,
    },
    "tool.execute.before": toolExecuteBeforeHook,
    "experimental.chat.system.transform": systemTransformHook,
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
