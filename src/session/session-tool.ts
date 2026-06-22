/**
 * session-tool.ts — 通用会话管理工具（v0.1 D5）
 *
 * Plugin 自注册的会话生命周期管理工具，不依赖任何实例特定的脚本。
 * 路径基于 file-system root（.serenity 向上遍历）动态解析。
 *
 * 子命令：
 *   list     — 列出 AGENT_SESSIONS/ 中的会话（活跃排前，▶ 标当前会话）
 *   show     — 查看指定会话详情
 *   create   — 创建会话（item / project 双模式）
 *   use      — 激活会话为当前上下文（仅活跃会话可用）
 *   close    — 关闭会话（需要 --confirm 确认）
 *   health   — 健康检查（stale/stalled/drift/ghost）
 *   archive  — 归档已关闭的超期会话
 *   summary  — 全局仪表盘
 */

import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import { findSerenityRoot, resolveRootPath, readSerenityCccName } from '../fs/resolve-path.js';
import { loadMechRegistryFrom } from '../msm.js';
import { SessionError } from '../errors.js';
import {
  listSessions,
  showSession,
  useSession,
  closeSession,
  resolveSessionInfo,
  healthCheck,
  createSession,
  archiveSessions,
  sessionSummary,
  qaSession,
} from './lib.js';
import { setActiveSession, removeActiveSession } from './active-state.js';

export const sessionTool: ToolDefinition = tool({
  description:
    'Session lifecycle management for cognitive containers (CCC). ' +
    'Manages AGENT_SESSIONS/ directory: list, show, create, use, close, health, qa, archive, summary. ' +
    'Use `use` to activate a session as current context for this conversation — it injects session info as LLM context. ' +
    'Close requires --confirm flag (must be true) to prevent accidental session closure. ' +
    'CCCs should register `session-tool` MSM that wraps `session` for domain-specific extensions.',
  args: {
    subcommand: z
      .enum(['list', 'show', 'create', 'use', 'close', 'health', 'qa', 'archive', 'summary'])
      .describe(
        'Operation to perform:\n' +
        '  list    — List all sessions with status summary (active/in-progress first)\n' +
        '  show    — View session details (accepts S###, directory name, or fuzzy keyword)\n' +
        '  create  — Create a new session (--type=item|project --desc <desc>)\n' +
        '  use     — Activate a session as current context (--name S###). Only active sessions can be used.\n' +
        '  close   — Close a session (requires --name + --confirm flag). Cannot be undone.\n' +
        '  health  — Health check: stale/stalled/drift/ghost\n' +
        '  qa      — Fact-check a session: verify SESSION.md claims against reality\n' +
        '  archive — Archive completed sessions past their grace period\n' +
        '  summary — Dashboard: stats + recent activity + warnings',
      ),
    name: z
      .string()
      .optional()
      .describe('Session identifier for show/use/close/archive subcommands (e.g. "S001", directory name, or fuzzy keyword)'),
    confirm: z
      .boolean()
      .optional()
      .default(false)
      .describe('Must be true for close subcommand — prevents accidental session closure'),
    'dry-run': z
      .boolean()
      .optional()
      .default(false)
      .describe('Preview changes without actually modifying files'),
    desc: z
      .string()
      .optional()
      .describe('Short description for create subcommand (any language, max 5 words)'),
    type: z
      .enum(['item', 'project'])
      .optional()
      .default('item')
      .describe('Session type for create: item (single task) or project (long-running)'),
    goal: z
      .string()
      .optional()
      .describe('Optional one-sentence goal for the session'),
  },
  execute: async (input, ctx) => {
    const cwd = ctx.directory;
    const root = findSerenityRoot(cwd);
    const sessionsDir = resolveRootPath(root, 'AGENT_SESSIONS');

    // 检测 CCC 是否注册了 session-tool MSM（D21：CCC 扩展层）
    const cccName = readSerenityCccName(root);
    const entries = cccName ? loadMechRegistryFrom(root, cccName) : [];
    const hasSessionTool = entries.some(e => e.name === 'session-tool');
    const extHint = hasSessionTool
      ? '\n\n[CCC] session-tool MSM 已注册，请参考 session-tool 使用扩展能力'
      : '\n\n[CCC] 如需扩展会话能力，可注册 session-tool MSM (msm_admin register)';

    const sub = input.subcommand;

    if (sub === 'list') {
      return listSessions(sessionsDir) + extHint;
    }

    if (sub === 'show') {
      if (!input.name) {
        throw new SessionError('session-tool show: requires --name (S### or directory name)');
      }
      return showSession(sessionsDir, input.name) + extHint;
    }

    if (sub === 'create') {
      if (!input.desc) {
        throw new SessionError('session-tool create: requires --desc (short description)');
      }
      // create 是 Semi-Mech 操作，由 LLM 完成命名/分类等认知决策
      // 此工具提供目录创建 + SESSION.md 骨架写入
      return createSession({
        sessionsDir,
        root,
        desc: input.desc,
        type: input.type ?? 'item',
        goal: input.goal,
        dryRun: input['dry-run'] ?? false,
      }) + extHint;
    }

    if (sub === 'use') {
      if (!input.name) {
        throw new SessionError('session-tool use: requires --name (S### or directory name)');
      }
      const info = resolveSessionInfo(sessionsDir, input.name);
      setActiveSession(ctx.sessionID, { sessionId: info.sessionId, dirName: info.dirName, mdPath: info.mdPath });
      return useSession(sessionsDir, input.name);
    }

    if (sub === 'close') {
      if (!input.name) {
        throw new SessionError('session-tool close: requires --name (S### or directory name)');
      }
      removeActiveSession(ctx.sessionID);
      return closeSession(sessionsDir, input.name, input.confirm ?? false);
    }

    if (sub === 'health') {
      return healthCheck(sessionsDir) + extHint;
    }

    if (sub === 'archive') {
      return archiveSessions({
        sessionsDir,
        name: input.name,
        dryRun: input['dry-run'] ?? false,
      }) + extHint;
    }

    if (sub === 'summary') {
      return sessionSummary(sessionsDir) + extHint;
    }

    if (sub === 'qa') {
      if (!input.name) {
        throw new SessionError('session-tool qa: requires --name (S### or directory name)');
      }
      return qaSession(sessionsDir, input.name) + extHint;
    }

    throw new SessionError(`session-tool: unknown subcommand "${sub}"`);
  },
});
