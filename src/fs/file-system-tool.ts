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

import { execFileSync } from 'node:child_process';
import {
  existsSync, statSync, readdirSync,
  mkdirSync, unlinkSync, rmdirSync, rmSync,
  renameSync, cpSync, utimesSync, writeFileSync,
  type Stats,
} from 'node:fs';
import { resolve, dirname, normalize } from 'node:path';
import { platform } from 'node:os';
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import { FileSystemError } from '../errors.js';
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

function detectFileType(stat: Stats): FileInfo['type'] {
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileInfo(absPath: string, name: string): FileInfo {
  try {
    const stat = statSync(absPath);
    return {
      name,
      type: detectFileType(stat),
      size: stat.size,
      sizeHuman: humanSize(stat.size),
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    return { name, type: 'other', size: 0, sizeHuman: '?', mtime: '?' };
  }
}

// ── 写操作路径校验 ──

function validateWritePath(root: string, target: string): string {
  const absPath = target.startsWith('/') ? normalize(target) : resolveRootPath(root, target);
  if (!isPathInsideSerenity(root, absPath)) {
    throw new FileSystemError(
      `cc-fs: path "${target}" resolves to "${absPath}" which is outside serenity root "${root}"`,
    );
  }
  // 保护 mech-registry.json — 只能通过 msm_admin 注册/注销
  if (absPath.endsWith('/mech-registry.json') && absPath.includes('/.opencode/skills/')) {
    throw new FileSystemError(
      `cc-fs: refusing to directly modify mech-registry.json — use msm_admin register/deregister instead`,
    );
  }
  return absPath;
}

function assertNotProtected(root: string, absPath: string, targetLabel: string): void {
  // Protect .serenity file from deletion
  const serenityMarker = resolve(root, '.serenity');
  if (absPath === serenityMarker) {
    throw new FileSystemError(
      `cc-fs: refusing to delete protected path: ${targetLabel} (.serenity is the CCC marker)`,
    );
  }
  // Protect the root directory itself
  if (absPath === root) {
    throw new FileSystemError(
      `cc-fs: refusing to delete the CCC root directory: ${targetLabel}`,
    );
  }
}

// ── Tool 定义 ──

const SUBCOMMANDS = [
  'root', 'resolve', 'exists', 'list', 'relative',
  'mkdir', 'rm', 'mv', 'cp', 'touch', 'tree', 'append',
  'reveal', 'info', 'find',
] as const;

export const fileSystemTool: ToolDefinition = tool({
  description:
    `Serenity file-system utility (v${VERSION}). ` +
    'Resolves paths relative to the CCC root (the directory containing .serenity). ' +
    'Use this instead of raw read/edit tools when you need to work with CCC paths. ' +
    'All subcommands validate that paths stay within the CCC root.',
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
        '  touch    — Create empty file or update timestamp\n' +
        '  tree     — Recursive directory listing, tree-like output as JSON\n' +
        '  append   — Append content to a file (like shell >>)\n' +
        '  reveal   — Open a path in the OS file manager (xdg-open on Linux, Finder on macOS)\n' +
        '  info     — Show detailed file/directory metadata (type, size, mtime, mode, owner)\n' +
        '  find     — Recursively search files by name pattern (glob or fuzzy substring)',
      ),
    path: z
      .string()
      .optional()
      .describe(
        'Single path argument for resolve/exists/list/relative/mkdir/touch/tree/append subcommands. ' +
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
    depth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .default(3)
      .describe('Max depth for tree subcommand (1-10, default 3)'),
    'files-only': z
      .boolean()
      .optional()
      .default(false)
      .describe('With tree: show only files'),
    'dirs-only': z
      .boolean()
      .optional()
      .default(false)
      .describe('With tree: show only directories'),
    content: z
      .string()
      .optional()
      .describe('Content to append (for append subcommand)'),
    pattern: z
      .string()
      .optional()
      .describe(
        'Glob or fuzzy filename pattern for find subcommand. ' +
        'Supports * (any chars) and ? (single char). ' +
        'Plain text does case-insensitive substring matching.',
      ),
    absolute: z
      .boolean()
      .optional()
      .default(false)
      .describe('With find: return absolute paths instead of relative-to-root'),
    'max-depth': z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('With find: maximum recursion depth (default: unlimited)'),
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
      if (!input.path) throw new FileSystemError('file-system resolve: requires a path argument');
      return resolveRootPath(root, input.path);
    }

    // ── relative ──
    if (sub === 'relative') {
      if (!input.path) throw new FileSystemError('file-system relative: requires a path argument');
      const absPath = input.path.startsWith('/')
        ? input.path
        : resolveRootPath(root, input.path);
      if (!isPathInsideSerenity(root, absPath)) {
        throw new FileSystemError(
          `file-system relative: path "${input.path}" resolves to "${absPath}" which is outside serenity root "${root}"`,
        );
      }
      return serenityPathRelative(root, absPath);
    }

    // ── exists ──
    if (sub === 'exists') {
      if (!input.path) throw new FileSystemError('file-system exists: requires a path argument');
      const absPath = input.path.startsWith('/')
        ? input.path
        : resolveRootPath(root, input.path);
      return existsSync(absPath) ? 'true' : 'false';
    }

    // ── list（增强：返回 JSON 元数据）──
    if (sub === 'list') {
      const relPath = input.path || '.';
      const absPath = relPath.startsWith('/')
        ? relPath
        : resolveRootPath(root, relPath);

      if (!existsSync(absPath)) {
        throw new FileSystemError(`file-system list: path "${absPath}" does not exist`);
      }

      const names = readdirSync(absPath);
      const entries = names.sort().map((name) => getFileInfo(resolve(absPath, name), name));

      return JSON.stringify({ path: absPath, entries, count: entries.length }, null, 2);
    }

    // ── mkdir（递归创建，类似 mkdir -p）──
    if (sub === 'mkdir') {
      if (!input.path) throw new FileSystemError('file-system mkdir: requires a path argument');
      const absPath = validateWritePath(root, input.path);

      if (existsSync(absPath)) {
        const stat = statSync(absPath);
        if (stat.isDirectory()) return `directory already exists: ${input.path}`;
        throw new FileSystemError(`file-system mkdir: path "${input.path}" exists but is not a directory`);
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
        throw new FileSystemError('file-system rm: requires at least one path argument (path or paths)');
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

        const stat = statSync(absPath);
        const isDir = stat.isDirectory();

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
        throw new FileSystemError('file-system mv: requires both --src and --dst arguments');
      }
      const srcAbs = validateWritePath(root, input.src);
      const dstAbs = validateWritePath(root, input.dst);

      if (!existsSync(srcAbs)) {
        throw new FileSystemError(`file-system mv: source not found: ${input.src}`);
      }
      if (existsSync(dstAbs)) {
        throw new FileSystemError(`file-system mv: destination already exists: ${input.dst}`);
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
        throw new FileSystemError('file-system cp: requires both --src and --dst arguments');
      }
      const srcAbs = validateWritePath(root, input.src);
      const dstAbs = validateWritePath(root, input.dst);

      if (!existsSync(srcAbs)) {
        throw new FileSystemError(`file-system cp: source not found: ${input.src}`);
      }
      if (existsSync(dstAbs)) {
        throw new FileSystemError(`file-system cp: destination already exists: ${input.dst}`);
      }

      const stat = statSync(srcAbs);
      if (stat.isDirectory() && !input.recursive) {
        throw new FileSystemError(
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
      if (!input.path) throw new FileSystemError('file-system touch: requires a path argument');
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

    // ── tree (recursive directory listing) ──
    if (sub === 'tree') {
      const relPath = input.path || '.';
      const absPath = relPath.startsWith('/')
        ? relPath
        : resolveRootPath(root, relPath);

      if (!existsSync(absPath)) {
        throw new FileSystemError(`file-system tree: path "${absPath}" does not exist`);
      }

      const maxDepth = input.depth ?? 3;
      const filesOnly = input['files-only'] ?? false;
      const dirsOnly = input['dirs-only'] ?? false;

      if (filesOnly && dirsOnly) {
        throw new FileSystemError('file-system tree: files-only and dirs-only are mutually exclusive');
      }

      function filterTree(entries: any[], keepType: string): any[] {
        return entries.filter(e => {
          if (e.type === keepType) {
            if (e.children) e.children = filterTree(e.children, keepType);
            return true;
          }
          return false;
        });
      }

      function walk(dir: string, currentDepth: number): any[] {
        if (currentDepth > maxDepth) return [];
        const names = readdirSync(dir).sort();
        return names.map(name => {
          const full = resolve(dir, name);
          const stat = statSync(full);
          const entry: any = {
            name,
            type: detectFileType(stat),
            size: stat.size,
            sizeHuman: humanSize(stat.size),
          };
          if (stat.isDirectory()) {
            entry.children = walk(full, currentDepth + 1);
          }
          return entry;
        });
      }

      let entries = walk(absPath, 1);

      if (filesOnly) {
        entries = filterTree(entries, 'file');
      }
      if (dirsOnly) {
        entries = filterTree(entries, 'dir');
      }

      return JSON.stringify({ path: absPath, entries, maxDepth }, null, 2);
    }

    // ── info (show file metadata) ──
    if (sub === 'info') {
      if (!input.path) throw new FileSystemError('file-system info: requires a path argument');
      const absPath = input.path.startsWith('/')
        ? input.path
        : resolveRootPath(root, input.path);

      if (!existsSync(absPath)) {
        throw new FileSystemError(`file-system info: path "${absPath}" does not exist`);
      }

      const stat = statSync(absPath);
      const fileType = detectFileType(stat);
      const modeStr = stat.mode.toString(8).slice(-4);

      return [
        `path: ${serenityPathRelative(root, absPath)}`,
        `type: ${fileType}`,
        `size: ${stat.size} (${humanSize(stat.size)})`,
        `mtime: ${stat.mtime.toISOString()}`,
        `mode: ${modeStr}`,
        `uid: ${stat.uid}`,
        `gid: ${stat.gid}`,
      ].join('\n');
    }

    // ── reveal (open path in OS file manager) ──
    if (sub === 'reveal') {
      if (!input.path) throw new FileSystemError('file-system reveal: requires a path argument');
      const absPath = input.path.startsWith('/')
        ? input.path
        : resolveRootPath(root, input.path);

      if (!existsSync(absPath)) {
        throw new FileSystemError(`file-system reveal: path "${absPath}" does not exist`);
      }

      const os = platform();
      try {
        if (os === 'darwin') {
          // macOS: open Finder with the item selected
          execFileSync('open', ['-R', absPath], { timeout: 10000 });
        } else if (os === 'linux') {
          // Linux: reveal the parent directory in default file manager
          // For files: open containing dir; for dirs: open the dir itself
          const revealPath = statSync(absPath).isDirectory() ? absPath : dirname(absPath);
          execFileSync('xdg-open', [revealPath], { timeout: 10000 });
        } else if (os === 'win32') {
          // Windows: open Explorer with the item selected
          execFileSync('explorer', ['/select,', absPath], { timeout: 10000 });
        } else {
          throw new FileSystemError(`file-system reveal: unsupported platform "${os}"`);
        }
        return `revealed in file manager: ${input.path}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new FileSystemError(`file-system reveal: failed to open "${input.path}": ${msg}`);
      }
    }

    // ── append (append content to file) ──
    if (sub === 'append') {
      if (!input.path) throw new FileSystemError('file-system append: requires a path argument');
      if (!input.content) throw new FileSystemError('file-system append: requires content argument');
      const absPath = validateWritePath(root, input.path);

      const parentDir = dirname(absPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      const content = input.content;
      writeFileSync(absPath, content, { flag: 'a' });
      return `appended ${Buffer.byteLength(content, 'utf8')} bytes to ${input.path}`;
    }

    // ── find (glob/fuzzy file search) ──
    if (sub === 'find') {
      if (!input.pattern) throw new FileSystemError('file-system find: requires a pattern argument');

      const relPath = input.path || '.';
      const absPath = relPath.startsWith('/')
        ? relPath
        : resolveRootPath(root, relPath);

      if (!existsSync(absPath)) {
        throw new FileSystemError(`file-system find: path "${absPath}" does not exist`);
      }

      const pattern = input.pattern;
      const absolutePaths = input.absolute ?? false;
      const maxDepth = input['max-depth'] ?? -1;
      const hasGlobChars = /[*?]/.test(pattern);

      function matchFilename(name: string): boolean {
        if (hasGlobChars) {
          const regexStr = '^' + pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') + '$';
          try {
            return new RegExp(regexStr).test(name);
          } catch {
            return name.includes(pattern);
          }
        }
        return name.toLowerCase().includes(pattern.toLowerCase());
      }

      function walkFind(dir: string, depth: number): void {
        if (maxDepth >= 0 && depth > maxDepth) return;
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          return;
        }
        for (const name of names.sort()) {
          const full = resolve(dir, name);
          let stat: Stats;
          try {
            stat = statSync(full);
          } catch {
            continue;
          }
          if (matchFilename(name)) {
            matches.push(absolutePaths ? full : serenityPathRelative(root, full));
          }
          if (stat.isDirectory()) {
            walkFind(full, depth + 1);
          }
        }
      }

      const matches: string[] = [];
      walkFind(absPath, 1);
      matches.sort();

      return JSON.stringify({ path: absPath, pattern, matches, count: matches.length }, null, 2);
    }

    throw new FileSystemError(`cc-fs: unknown subcommand "${sub}"`);
  },
});
