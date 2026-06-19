/**
 * session-tool.ts — 通用会话管理工具（v0.1 D5）
 *
 * Plugin 自注册的会话生命周期管理工具，不依赖任何实例特定的脚本。
 * 路径基于 file-system root（.serenity 向上遍历）动态解析。
 *
 * 子命令：
 *   list     — 列出 AGENT_SESSIONS/ 中的会话
 *   show     — 查看指定会话详情
 *   create   — 创建会话（item / project 双模式）
 *   health   — 健康检查（stale/stalled/drift/ghost）
 *   archive  — 归档已关闭的超期会话
 *   summary  — 全局仪表盘
 */

import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import { findSerenityRoot, resolveRootPath } from '../fs/resolve-path.js';
import { SessionError } from '../errors.js';
import {
  listSessions,
  showSession,
  healthCheck,
  createSession,
  archiveSessions,
  sessionSummary,
  qaSession,
} from './lib.js';

export const sessionTool: ToolDefinition = tool({
  description:
    'Session lifecycle management for cognitive containers (CCC). ' +
    'Manages AGENT_SESSIONS/ directory: list, show, create, health, archive, summary. ' +
    'All paths are resolved relative to the CCC root.',
  args: {
    subcommand: z
      .enum(['list', 'show', 'create', 'health', 'qa', 'archive', 'summary'])
      .describe(
        'Operation to perform:\n' +
        '  list    — List all sessions with status summary\n' +
        '  show    — View session details (accepts S### or directory name)\n' +
        '  create  — Create a new session (--type=item|project --desc <desc>)\n' +
        '  health  — Health check: stale/stalled/drift/ghost\n' +
        '  qa      — Fact-check a session: verify SESSION.md claims against reality\n' +
        '  archive — Archive completed sessions past their grace period\n' +
        '  summary — Dashboard: stats + recent activity + warnings',
      ),
    name: z
      .string()
      .optional()
      .describe('Session identifier for show/archive subcommands (e.g. "S001" or directory name)'),
    desc: z
      .string()
      .optional()
      .describe('Short description for create subcommand (kebab-case, max 5 words)'),
    type: z
      .enum(['item', 'project'])
      .optional()
      .default('item')
      .describe('Session type for create: item (single task) or project (long-running)'),
    goal: z
      .string()
      .optional()
      .describe('Optional one-sentence goal for the session'),
    'dry-run': z
      .boolean()
      .optional()
      .default(false)
      .describe('Preview changes without actually modifying files'),
  },
  execute: async (input, ctx) => {
    const cwd = ctx.directory;
    const root = findSerenityRoot(cwd);
    const sessionsDir = resolveRootPath(root, 'AGENT_SESSIONS');

    const sub = input.subcommand;

    if (sub === 'list') {
      return listSessions(sessionsDir);
    }

    if (sub === 'show') {
      if (!input.name) {
        throw new SessionError('session-tool show: requires --name (S### or directory name)');
      }
      return showSession(sessionsDir, input.name);
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
      });
    }

    if (sub === 'health') {
      return healthCheck(sessionsDir);
    }

    if (sub === 'archive') {
      return archiveSessions({
        sessionsDir,
        name: input.name,
        dryRun: input['dry-run'] ?? false,
      });
    }

    if (sub === 'summary') {
      return sessionSummary(sessionsDir);
    }

    if (sub === 'qa') {
      if (!input.name) {
        throw new SessionError('session-tool qa: requires --name (S### or directory name)');
      }
      return qaSession(sessionsDir, input.name);
    }

    throw new SessionError(`session-tool: unknown subcommand "${sub}"`);
  },
});
