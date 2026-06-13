/**
 * file-system-tool.ts — 宁静号文件系统基础设施工具
 *
 * 提供跨实例的文件系统操作，不依赖任何实例特定的脚本。
 * 所有路径基于 .serenity 向上遍历动态解析。
 *
 * 子命令：
 *   root     — 寻找并返回宁静号实例根目录
 *   resolve  — 将相对路径基于根目录解析为绝对路径
 *   exists   — 检测路径是否存在
 *   list     — 列出目录内容（含元数据）
 *   relative — 返回相对于根的相对路径
 *   mkdir    — 创建目录（递归，类似 mkdir -p）
 *   rm       — 删除文件/目录（支持多路径批量，--recursive，--dry-run）
 *   mv       — 移动/重命名
 *   cp       — 复制文件/目录（--recursive）
 *   touch    — 创建空文件或更新时间戳
 *
 * 安全约束：
 *   - 写操作（mkdir/rm/mv/cp/touch）自动限制在 .serenity 根内
 *   - .serenity 文件本身受保护不可删除
 */

import {
  existsSync, statSync, readdirSync,
  mkdirSync, unlinkSync, rmdirSync, rmSync,
  renameSync, cpSync, utimesSync, writeFileSync,
  type Stats,
} from 'node:fs';
import { resolve, dirname, normalize } from 'node:path';
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

// ── 文件元数据类型 ──

interface FileInfo {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  sizeHuman: string;
  mtime: string;
}

function detectFileType(st: Stats): FileInfo['type'] {
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  if (st.isSymbolicLink()) return 'symlink';
  return 'other';
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileInfo(absPath: string, name: string): FileInfo {
  try {
    const st = statSync(absPath);
    return {
      name,
      type: detectFileType(st),
      size: st.size,
      sizeHuman: humanSize(st.size),
      mtime: st.mtime.toISOString(),
    };
  } catch {
    return { name, type: 'other', size: 0, sizeHuman: '?', mtime: '?' };
  }
}

// ── 写操作路径校验 ──

function validateWritePath(root: string, target: string): string {
  const absPath = target.startsWith('/') ? normalize(target) : resolveRootPath(root, target);
  if (!isPathInsideSerenity(root, absPath)) {
    throw new Error(
      `file-system: path "${target}" resolves to "${absPath}" which is outside serenity root "${root}"`,
    );
  }
  return absPath;
}

function assertNotProtected(root: string, absPath: string, targetLabel: string): void {
  // Protect .serenity file from deletion
  const serenityMarker = resolve(root, '.serenity');
  if (absPath === serenityMarker) {
    throw new Error(
      `file-system: refusing to delete protected path: ${targetLabel} (.serenity is the serenity instance marker)`,
    );
  }
  // Protect the root directory itself
  if (absPath === root) {
    throw new Error(
      `file-system: refusing to delete the serenity root directory: ${targetLabel}`,
    );
  }
}

// ── Tool 定义 ──

const SUBCOMMANDS = [
  'root', 'resolve', 'exists', 'list', 'relative',
  'mkdir', 'rm', 'mv', 'cp', 'touch',
] as const;

export const fileSystemTool: ToolDefinition = tool({
  description:
    `Serenity file-system utility (v${VERSION}). ` +
    'Resolves paths relative to the serenity instance root (the directory containing .serenity). ' +
    'Use this instead of raw read/edit tools when you need to work with serenity instance paths. ' +
    'All subcommands validate that paths stay within the serenity root.',
  args: {
    subcommand: z
      .enum(SUBCOMMANDS)
      .describe(
        'Operation to perform:\n' +
        '  root     — Find and return the serenity root directory\n' +
        '  resolve  — Resolve a relative path to absolute (relative to root)\n' +
        '  exists   — Check if a path exists\n' +
        '  list     — List directory contents with metadata (JSON)\n' +
        '  relative — Get path relative to serenity root\n' +
        '  mkdir    — Create directory (recursive, like mkdir -p)\n' +
        '  rm       — Delete files/directories (batch: pass multiple paths via paths arg)\n' +
        '  mv       — Move or rename a file/directory\n' +
        '  cp       — Copy a file or directory\n' +
        '  touch    — Create empty file or update timestamp',
      ),
    path: z
      .string()
      .optional()
      .describe(
        'Single path argument for resolve/exists/list/relative/mkdir/touch subcommands. ' +
        'Can be relative (from serenity root) or absolute (must be inside serenity root for write operations).',
      ),
    paths: z
      .array(z.string())
      .optional()
      .describe(
        'Multiple paths for rm batch delete. ' +
        'Each path can be relative or absolute (must be inside serenity root). ' +
        'Also accepts a single path via the "path" arg for convenience.',
      ),
    src: z
      .string()
      .optional()
      .describe('Source path for mv/cp subcommands.'),
    dst: z
      .string()
      .optional()
      .describe('Destination path for mv/cp subcommands.'),
    recursive: z
      .boolean()
      .optional()
      .default(false)
      .describe('Recursive operation for rm (delete directories) and cp (copy directories).'),
    'dry-run': z
      .boolean()
      .optional()
      .default(false)
      .describe('Preview changes without actually modifying files. Supported by rm.'),
  },
  execute: async (input, ctx) => {
    const cwd = ctx.directory;
    const root = findSerenityRoot(cwd);
    const sub = input.subcommand;

    // ── root ──
    if (sub === 'root') {
      return root;
    }

    // ── resolve ──
    if (sub === 'resolve') {
      if (!input.path) throw new Error('file-system resolve: requires a path argument');
      return resolveRootPath(root, input.path);
    }

    // ── relative ──
    if (sub === 'relative') {
      if (!input.path) throw new Error('file-system relative: requires a path argument');
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

    // ── exists ──
    if (sub === 'exists') {
      if (!input.path) throw new Error('file-system exists: requires a path argument');
      const absPath = input.path.startsWith('/')
        ? input.path
        : resolveRootPath(root, input.path);
      return existsSync(absPath) ? 'true' : 'false';
    }

    // ── list（增强：返回 JSON 元数据）──
    if (sub === 'list') {
      if (!input.path) throw new Error('file-system list: requires a path argument');
      const absPath = input.path.startsWith('/')
        ? input.path
        : resolveRootPath(root, input.path);

      if (!existsSync(absPath)) {
        throw new Error(`file-system list: path "${absPath}" does not exist`);
      }

      const names = readdirSync(absPath);
      const entries = names.sort().map((name) => getFileInfo(resolve(absPath, name), name));

      return JSON.stringify({ path: absPath, entries, count: entries.length }, null, 2);
    }

    // ── mkdir（递归创建，类似 mkdir -p）──
    if (sub === 'mkdir') {
      if (!input.path) throw new Error('file-system mkdir: requires a path argument');
      const absPath = validateWritePath(root, input.path);

      if (existsSync(absPath)) {
        const st = statSync(absPath);
        if (st.isDirectory()) return `directory already exists: ${input.path}`;
        throw new Error(`file-system mkdir: path "${input.path}" exists but is not a directory`);
      }

      mkdirSync(absPath, { recursive: true });
      return `created directory: ${input.path}`;
    }

    // ── rm（多路径批量删除）──
    if (sub === 'rm') {
      // 合并单路径和多路径参数
      const targets: string[] = [...(input.paths ?? [])];
      if (input.path) targets.push(input.path);
      if (targets.length === 0) {
        throw new Error('file-system rm: requires at least one path argument (path or paths)');
      }

      const dryRun = input['dry-run'] ?? false;
      const recursive = input.recursive ?? false;
      const results: string[] = [];

      for (const target of targets) {
        const absPath = validateWritePath(root, target);

        if (!existsSync(absPath)) {
          results.push(`[SKIP] not found: ${target}`);
          continue;
        }

        const st = statSync(absPath);
        const isDir = st.isDirectory();

        // 保护 .serenity 和根目录
        try {
          assertNotProtected(root, absPath, target);
        } catch (e) {
          results.push(`[SKIP] ${(e as Error).message}`);
          continue;
        }

        const relLabel = serenityPathRelative(root, absPath);

        if (dryRun) {
          const extra = isDir ? (recursive ? ' (recursive)' : '') : '';
          results.push(`[DRY-RUN] ${isDir ? 'directory' : 'file'}: ${relLabel}${extra}`);
          continue;
        }

        if (isDir && !recursive) {
          const entries = readdirSync(absPath);
          if (entries.length > 0) {
            results.push(
              `[SKIP] directory not empty (${entries.length} items), use --recursive: ${relLabel}`,
            );
            continue;
          }
          rmdirSync(absPath);
        } else if (isDir) {
          rmSync(absPath, { recursive: true, force: false });
        } else {
          unlinkSync(absPath);
        }

        results.push(`[OK] deleted: ${relLabel}`);
      }

      return results.join('\n');
    }

    // ── mv（移动/重命名）──
    if (sub === 'mv') {
      if (!input.src || !input.dst) {
        throw new Error('file-system mv: requires both --src and --dst arguments');
      }
      const srcAbs = validateWritePath(root, input.src);
      const dstAbs = validateWritePath(root, input.dst);

      if (!existsSync(srcAbs)) {
        throw new Error(`file-system mv: source not found: ${input.src}`);
      }
      if (existsSync(dstAbs)) {
        throw new Error(`file-system mv: destination already exists: ${input.dst}`);
      }

      // 自动创建目标父目录
      const parentDir = dirname(dstAbs);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      renameSync(srcAbs, dstAbs);
      return `moved: ${input.src} \u2192 ${input.dst}`;
    }

    // ── cp（复制）──
    if (sub === 'cp') {
      if (!input.src || !input.dst) {
        throw new Error('file-system cp: requires both --src and --dst arguments');
      }
      const srcAbs = validateWritePath(root, input.src);
      const dstAbs = validateWritePath(root, input.dst);

      if (!existsSync(srcAbs)) {
        throw new Error(`file-system cp: source not found: ${input.src}`);
      }
      if (existsSync(dstAbs)) {
        throw new Error(`file-system cp: destination already exists: ${input.dst}`);
      }

      const st = statSync(srcAbs);
      if (st.isDirectory() && !input.recursive) {
        throw new Error(
          `file-system cp: source is a directory, use --recursive to copy: ${input.src}`,
        );
      }

      // 自动创建目标父目录
      const parentDir = dirname(dstAbs);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      cpSync(srcAbs, dstAbs, { recursive: input.recursive ?? false });
      return `copied: ${input.src} \u2192 ${input.dst}`;
    }

    // ── touch（创建空文件 / 更新时间戳）──
    if (sub === 'touch') {
      if (!input.path) throw new Error('file-system touch: requires a path argument');
      const absPath = validateWritePath(root, input.path);

      if (existsSync(absPath)) {
        // 更新时间戳到当前时间
        const now = new Date();
        utimesSync(absPath, now, now);
        return `updated timestamp: ${input.path}`;
      }

      // 创建空文件，自动创建父目录
      const parentDir = dirname(absPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(absPath, '', 'utf8');
      return `created empty file: ${input.path}`;
    }

    throw new Error(`file-system: unknown subcommand "${sub}"`);
  },
});
