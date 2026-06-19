/**
 * opencode-serenity-plugin — server entry
 *
 * 职责：注册 9 个自定义工具 + 6 个 system hook，实现 serenity 认知基础设施的
 *       plugin 层（MSM 框架、文件系统操作、会话管理、路径守卫、skill 注入等）。
 *
 * 设计文档见 docs/：
 *   - architecture-v0.md — 两阶段 init + 模块分解
 *   - contract-v0.md — 6 契约 + 13 错误类
 *   - requirements-v0-scope.md — RR1-RR7 范围层
 *
 * Hook 工厂分层：
 *   createPermissionGuards → tool.execute.before（RR5 路径守卫 + bash 开关）
 *   createCompactingHooks  → system.transform（SKILL.md 注入）
 *                           + session.compacting（关键状态保留）
 *                           + tool.definition（subagent context 注入）
 *   createShellEnv         → shell.env（HOME_SERENITY_ROOT + SERENITY_INSTANCE）
 *   createPermissionAutoReply → event permission.asked（cwdRoot 内自动 always）
 */

import type { Plugin, Hooks } from '@opencode-ai/plugin';
import { tryActivateSync } from './activation.js';
import {
  msmListTool,
  msmExecTool,
  msmAdminTool,

} from './msm.js';
import { fileSystemTool } from './fs/file-system-tool.js';
import { sessionTool } from './session/session-tool.js';
import { cccStatusTool } from './ccc-status.js';
import { eapTool } from './eap-tool.js';
import { neatTool } from './neat-tool.js';
import { ccGitTool } from './git/cc-git-tool.js';
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
      msm_list: msmListTool,
      msm_exec: msmExecTool,
      msm_admin: msmAdminTool,
      cc_fs: fileSystemTool, // v0.1 D4: 跨实例文件系统工具 (D20: renamed to cc-fs)
      session: sessionTool, // v0.1 D5: 通用会话管理工具
      cc_ck: cccStatusTool, // v0.3 D18: CCC 三原则状态检查
      eap: eapTool,        // v0.3: EAP 认知质量框架 (渐进式披露)
      neat: neatTool,      // v0.3: Neat 设计协作协议 (渐进式披露)
      cc_git: ccGitTool,   // v0.4: CCC git 管理工具 (status/commit/push/log)
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
