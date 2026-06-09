/**
 * file-system-tool.ts — 宁静号文件系统基础设施工具
 *
 * 提供跨实例的文件系统操作，不依赖任何实例特定的脚本。
 * 所有路径基于 .serenity 向上遍历动态解析。
 *
 * 子命令：
 *   root    — 寻找并返回宁静号实例根目录
 *   resolve — 将相对路径基于根目录解析为绝对路径
 *   exists  — 检测路径是否存在
 *   list    — 列出目录内容
 *   relative — 返回相对于根的相对路径
 */

import { existsSync, readdirSync } from 'node:fs';
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import {
  findSerenityRoot,
  resolveRootPath,
  isPathInsideSerenity,
  serenityPathRelative,
} from './resolve-path.js';
import pkg from '../../package.json' with { type: 'json' };

const VERSION: string = pkg.version;

export const fileSystemTool: ToolDefinition = tool({
  description:
    `Serenity file-system utility (v${VERSION}). ` +
    'Resolves paths relative to the serenity instance root (the directory containing .serenity). ' +
    'Use this instead of raw read/edit tools when you need to work with serenity instance paths. ' +
    'All subcommands validate that paths stay within the serenity root.',
  args: {
    subcommand: z
      .enum(['root', 'resolve', 'exists', 'list', 'relative'])
      .describe(
        'Operation to perform:\n' +
        '  root     — Find and return the serenity root directory\n' +
        '  resolve  — Resolve a relative path to absolute (relative to root)\n' +
        '  exists   — Check if a path exists\n' +
        '  list     — List directory contents\n' +
        '  relative — Get path relative to serenity root',
      ),
    path: z
      .string()
      .optional()
      .describe('Path argument for resolve/exists/list/relative subcommands. ' +
        'Can be relative (from serenity root) or absolute (must be inside serenity root).'),
  },
  execute: async (input, ctx) => {
    const cwd = ctx.directory;
    const subcommand = input.subcommand;

    // root: 不需要 path，直接找根
    if (subcommand === 'root') {
      const root = findSerenityRoot(cwd);
      return root;
    }

    // 其他子命令需要 path
    if (!input.path) {
      throw new Error(`file-system: subcommand "${subcommand}" requires a path argument`);
    }

    const root = findSerenityRoot(cwd);

    if (subcommand === 'resolve') {
      const absPath = resolveRootPath(root, input.path);
      return absPath;
    }

    if (subcommand === 'relative') {
      const absPath = input.path.startsWith('/')
        ? input.path
        : resolveRootPath(root, input.path);
      if (!isPathInsideSerenity(root, absPath)) {
        throw new Error(
          `file-system relative: path "${input.path}" resolves to "${absPath}" which is outside serenity root "${root}"`,
        );
      }
      return serenityPathRelative(root, absPath);
    }

    if (subcommand === 'exists') {
      const absPath = input.path.startsWith('/')
        ? input.path
        : resolveRootPath(root, input.path);
      return existsSync(absPath) ? 'true' : 'false';
    }

    if (subcommand === 'list') {
      const absPath = input.path.startsWith('/')
        ? input.path
        : resolveRootPath(root, input.path);
      if (!existsSync(absPath)) {
        throw new Error(`file-system list: path "${absPath}" does not exist`);
      }
      const entries = readdirSync(absPath, { withFileTypes: true });
      return entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n');
    }

    throw new Error(`file-system: unknown subcommand "${subcommand}"`);
  },
});
