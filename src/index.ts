/**
 * opencode-serenity-plugin — v1.9 入口（v0.1 + v1-1 symlink + v1.1 msm_register + v1.3 auto-perm）
 *
 * 启动协议见 architecture-v0.md
 * 契约见 contract-v0.md
 * 范围层见 docs/requirements-v0-scope.md（RR1-RR7）
 * v0.1 变更见 docs/v0.1-candidates.md（候选 1：两阶段 init / 候选 3：hook 工厂分层）
 * v1-1 变更：msm-schema symlink 防御（fs.realpathSync）
 * v1.1 变更：msm_register + msm_deregister 工具
 * v1.3 变更：permission auto-reply（监听 permission.asked event，cwdRoot 内 always）
 * v1.9 变更：default export 改为 { id, server } 对象形式（R-β fix，与 tui.ts 对称）
 *
 * Hook 工厂分层（v0.1-3 + v1.3）：
 * - createPermissionGuards：tool.execute.before（RR3 bash 防御 + RR5 路径守卫）
 * - createCompactingHooks：system.transform（RR3/RR7 提示）+ session.compacting（关键状态注入）
 * - createShellEnv：shell.env（HOME_SERENITY_ROOT + SERENITY_INSTANCE 注入）
 * - createPermissionAutoReply：event hook（监听 permission.asked → reply "always" cwdRoot 内）
 *
 * 注意：v1-2 hashline edit 已撤回（实测 LLM 用得糟糕，见 commit history）
 */

import type { Plugin, Hooks } from '@opencode-ai/plugin';
import { tryActivateSync } from './activation.js';
import {
  msmListTool,
  msmExecTool,
  msmRegisterTool,
  msmDeregisterTool,
} from './msm.js';
import { bashOverrideTool } from './bash-override.js';
import { createPermissionGuards } from './hooks/permission-guards.js';
import { createCompactingHooks } from './hooks/compacting.js';
import { createShellEnv } from './hooks/shell-env.js';
import { createPermissionAutoReplyHandler } from './hooks/permission-auto-reply.js';
import { log } from './util/log.js';

const plugin: Plugin = async (input) => {
  log.info('entry', 'plugin loading', { directory: input.directory, worktree: input.worktree });

  // Phase 1: 同步 RR6 验证（git repo）
  const syncResult = tryActivateSync(input, () => input.client);

  if (!syncResult.ok) {
    log.warn('entry', 'plugin not activated', { reason: syncResult.reason });
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
      msm_register: msmRegisterTool, // v1.1: 填补"写了 MSM 无法注册"空白
      msm_deregister: msmDeregisterTool, // v1.1: 对称删除
    },
    ...createPermissionGuards(),
    ...createCompactingHooks(),
    ...createShellEnv(),
    event: createPermissionAutoReplyHandler({
      getServerUrl: () => input.serverUrl,
    }),
  };

  log.info('entry', 'phase 1 ok; phase 2 loading in background', { cwdRoot: syncResult.cwdRoot });
  log.info('entry', 'registered tools', { tools: Object.keys(hooks.tool ?? {}) });
  return hooks;
};

export default {
  id: 'opencode-serenity-plugin-server',
  server: plugin,
};

// 保留旧 export 兼容（tests 用）
export { isActive } from './state.js';
