/**
 * opencode-serenity-plugin — v0 入口
 *
 * 10 步启动协议见 architecture-v0.md
 * 契约见 contract-v0.md
 * 范围层见 docs/requirements-v0-scope.md（RR1-RR7）
 */

import type { Plugin, Hooks } from '@opencode-ai/plugin';
import { tryActivate } from './activation.js';
import { isActive } from './state.js';
import { msmListTool, msmExecTool } from './msm.js';
import { bashOverrideTool } from './bash-override.js';
import { toolExecuteBeforeHook } from './permission.js';
import { systemTransformHook } from './commands.js';

const plugin: Plugin = async (input) => {
  // 步骤 1-7: 启动协议
  const result = tryActivate(input);

  if (!result.ok) {
    // 不激活 = "就像没装一样"
    // 不抛错（抛错会中断 opencode 启动）；返回空 Hooks
    // 可选：console.log 记录原因（用户调试用）
    // eslint-disable-next-line no-console
    console.warn(`[serenity-plugin] not activated: ${result.reason}`);
    return {};
  }

  // 步骤 8-10: 注册 hooks + tools
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
    `[serenity-plugin] activated: instance="${result.state.instanceName}" cwdRoot="${result.state.cwdRoot}"`,
  );
  return hooks;
};

export default plugin;

// 导出 isActive 供 tests 用（避免 unused 警告）
export { isActive };
