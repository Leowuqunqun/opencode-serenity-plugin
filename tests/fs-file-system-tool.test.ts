/**
 * fs-file-system-tool.test.ts — file-system tool 单元测试（v0.1 D4 增强）
 *
 * 范围：
 * - 只读子命令（root / resolve / exists / relative / list）
 * - 写子命令（mkdir / rm / mv / cp / touch）
 * - 安全约束（写操作限 root 内、.serenity 保护）
 * - 错误路径
 *
 * 所有测试在临时目录中运行，测试后清理。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync, statSync, readdirSync, readFileSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileSystemTool } from '../src/fs/file-system-tool.js';

// ── Helper：创建临宁静号实例 ──

const INSTANCE = 'test-instance';

function createSerenityInstance(): string {
  const root = mkdtempSync(join(tmpdir(), 'fs-test-'));
  // git init（RR6）
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root, stdio: 'ignore' });
  // .serenity（RR1）
  writeFileSync(join(root, '.serenity'), INSTANCE);
  // SKILL.md（RR2）
  const skillDir = join(root, '.opencode', 'skills', INSTANCE);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# test skill');
  // 初始 commit
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
  return root;
}

// ── Helper：创建 mock ctx ──

function mockCtx(root: string) {
  return { directory: root } as any;
}

// ── Helper：调用工具 ──

async function callFs(input: Record<string, any>, root: string): Promise<string> {
  return fileSystemTool.execute(input, mockCtx(root)) as Promise<string>;
}

describe('file-system tool — 只读子命令', () => {
  let root: string;

  beforeEach(() => {
    root = createSerenityInstance();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('root — 返回 .serenity 所在目录', async () => {
    const result = await callFs({ subcommand: 'root' }, root);
    expect(result).toBe(root);
  });

  it('resolve — 相对路径解析为绝对路径', async () => {
    const result = await callFs({ subcommand: 'resolve', path: 'AGENT_SESSIONS' }, root);
    expect(result).toBe(join(root, 'AGENT_SESSIONS'));
  });

  it('resolve — 绝对路径透传', async () => {
    const result = await callFs({ subcommand: 'resolve', path: '/tmp' }, root);
    expect(result).toBe('/tmp');
  });

  it('resolve — 无 path 参数时报错', async () => {
    await expect(callFs({ subcommand: 'resolve' }, root)).rejects.toThrow('path argument');
  });

  it('exists — 存在的路径返回 true', async () => {
    const result = await callFs({ subcommand: 'exists', path: '.serenity' }, root);
    expect(result).toBe('true');
  });

  it('exists — 不存在的路径返回 false', async () => {
    const result = await callFs({ subcommand: 'exists', path: 'nonexistent' }, root);
    expect(result).toBe('false');
  });

  it('relative — 返回相对于根的路径', async () => {
    const result = await callFs({ subcommand: 'relative', path: '.serenity' }, root);
    expect(result).toBe('.serenity');
  });

  it('relative — 根外路径报错', async () => {
    await expect(callFs({ subcommand: 'relative', path: '/tmp' }, root)).rejects.toThrow('outside serenity root');
  });

  it('list — 返回 JSON 格式的目录内容', async () => {
    const result = await callFs({ subcommand: 'list', path: '.' }, root);
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('path', root);
    expect(parsed).toHaveProperty('entries');
    expect(parsed).toHaveProperty('count');
    expect(Array.isArray(parsed.entries)).toBe(true);
    // 应该包含 .serenity
    const serenityEntry = parsed.entries.find((e: any) => e.name === '.serenity');
    expect(serenityEntry).toBeDefined();
    expect(serenityEntry.type).toBe('file');
    expect(serenityEntry).toHaveProperty('size');
    expect(serenityEntry).toHaveProperty('mtime');
  });

  it('list — 不存在的路径报错', async () => {
    await expect(callFs({ subcommand: 'list', path: 'nonexistent' }, root)).rejects.toThrow('does not exist');
  });
});

describe('file-system tool — mkdir', () => {
  let root: string;

  beforeEach(() => {
    root = createSerenityInstance();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('创建单层目录', async () => {
    const result = await callFs({ subcommand: 'mkdir', path: 'new-dir' }, root);
    expect(result).toBe('created directory: new-dir');
    expect(existsSync(join(root, 'new-dir'))).toBe(true);
    expect(statSync(join(root, 'new-dir')).isDirectory()).toBe(true);
  });

  it('递归创建多层目录', async () => {
    const result = await callFs({ subcommand: 'mkdir', path: 'a/b/c' }, root);
    expect(result).toBe('created directory: a/b/c');
    expect(existsSync(join(root, 'a/b/c'))).toBe(true);
    expect(statSync(join(root, 'a/b/c')).isDirectory()).toBe(true);
  });

  it('已存在的目录返回提示,不报错', async () => {
    mkdirSync(join(root, 'existing'), { recursive: true });
    const result = await callFs({ subcommand: 'mkdir', path: 'existing' }, root);
    expect(result).toBe('directory already exists: existing');
  });

  it('根外路径报错', async () => {
    await expect(callFs({ subcommand: 'mkdir', path: '/outside-dir' }, root)).rejects.toThrow('outside serenity root');
  });
});

describe('file-system tool — rm（批量删除）', () => {
  let root: string;

  beforeEach(() => {
    root = createSerenityInstance();
    // 创建测试文件
    writeFileSync(join(root, 'file1.txt'), 'content1');
    writeFileSync(join(root, 'file2.txt'), 'content2');
    writeFileSync(join(root, 'file3.log'), 'content3');
    mkdirSync(join(root, 'subdir'));
    writeFileSync(join(root, 'subdir', 'nested.txt'), 'nested');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('删除单个文件', async () => {
    const result = await callFs({ subcommand: 'rm', path: 'file1.txt' }, root);
    expect(result).toContain('[OK] deleted:');
    expect(existsSync(join(root, 'file1.txt'))).toBe(false);
  });

  it('批量删除多个文件（paths 数组）', async () => {
    const result = await callFs({ subcommand: 'rm', paths: ['file1.txt', 'file2.txt'] }, root);
    expect(result).toContain('[OK] deleted: file1.txt');
    expect(result).toContain('[OK] deleted: file2.txt');
    expect(existsSync(join(root, 'file1.txt'))).toBe(false);
    expect(existsSync(join(root, 'file2.txt'))).toBe(false);
    // file3.log 应该还在
    expect(existsSync(join(root, 'file3.log'))).toBe(true);
  });

  it('递归删除目录（--recursive）', async () => {
    const result = await callFs({ subcommand: 'rm', path: 'subdir', recursive: true }, root);
    expect(result).toContain('[OK] deleted:');
    expect(existsSync(join(root, 'subdir'))).toBe(false);
  });

  it('非空目录无 --recursive 时报错', async () => {
    const result = await callFs({ subcommand: 'rm', path: 'subdir' }, root);
    expect(result).toContain('[SKIP] directory not empty');
    expect(existsSync(join(root, 'subdir'))).toBe(true);
  });

  it('不存在的路径返回 SKIP', async () => {
    const result = await callFs({ subcommand: 'rm', path: 'nonexistent' }, root);
    expect(result).toContain('[SKIP] not found');
  });

  it('--dry-run 预览删除', async () => {
    const result = await callFs({ subcommand: 'rm', path: 'file1.txt', 'dry-run': true }, root);
    expect(result).toContain('[DRY-RUN]');
    expect(existsSync(join(root, 'file1.txt'))).toBe(true); // 文件还在
  });

  it('拒绝删除 .serenity 保护文件', async () => {
    const result = await callFs({ subcommand: 'rm', path: '.serenity' }, root);
    expect(result).toContain('[SKIP]');
    expect(existsSync(join(root, '.serenity'))).toBe(true);
  });

  it('拒绝删除根目录', async () => {
    const result = await callFs({ subcommand: 'rm', path: '.' }, root);
    expect(result).toContain('[SKIP]');
  });

  it('根外路径报错', async () => {
    await expect(callFs({ subcommand: 'rm', path: '/tmp/outside' }, root)).rejects.toThrow('outside serenity root');
  });

  it('无路径参数时报错', async () => {
    await expect(callFs({ subcommand: 'rm' }, root)).rejects.toThrow('at least one path argument');
  });
});

describe('file-system tool — mv', () => {
  let root: string;

  beforeEach(() => {
    root = createSerenityInstance();
    writeFileSync(join(root, 'source.txt'), 'move me');
    mkdirSync(join(root, 'sub'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('移动文件（重命名）', async () => {
    const result = await callFs({ subcommand: 'mv', src: 'source.txt', dst: 'dest.txt' }, root);
    expect(result).toContain('moved:');
    expect(existsSync(join(root, 'source.txt'))).toBe(false);
    expect(existsSync(join(root, 'dest.txt'))).toBe(true);
    expect(readFileSync(join(root, 'dest.txt'), 'utf8')).toBe('move me');
  });

  it('自动创建目标父目录', async () => {
    const result = await callFs({ subcommand: 'mv', src: 'source.txt', dst: 'a/b/dest.txt' }, root);
    expect(result).toContain('moved:');
    expect(existsSync(join(root, 'a/b/dest.txt'))).toBe(true);
  });

  it('源不存在时报错', async () => {
    await expect(callFs({ subcommand: 'mv', src: 'nonexistent', dst: 'dest.txt' }, root)).rejects.toThrow('source not found');
  });

  it('目标已存在时报错', async () => {
    writeFileSync(join(root, 'existing.txt'), 'existing');
    await expect(callFs({ subcommand: 'mv', src: 'source.txt', dst: 'existing.txt' }, root)).rejects.toThrow('destination already exists');
  });

  it('缺参数时报错', async () => {
    await expect(callFs({ subcommand: 'mv', src: 'source.txt' }, root)).rejects.toThrow('requires both');
  });
});

describe('file-system tool — cp', () => {
  let root: string;

  beforeEach(() => {
    root = createSerenityInstance();
    writeFileSync(join(root, 'source.txt'), 'copy me');
    mkdirSync(join(root, 'sourcedir'));
    writeFileSync(join(root, 'sourcedir', 'nested.txt'), 'nested');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('复制单个文件', async () => {
    const result = await callFs({ subcommand: 'cp', src: 'source.txt', dst: 'copy.txt' }, root);
    expect(result).toContain('copied:');
    expect(existsSync(join(root, 'copy.txt'))).toBe(true);
    expect(readFileSync(join(root, 'copy.txt'), 'utf8')).toBe('copy me');
    expect(existsSync(join(root, 'source.txt'))).toBe(true); // 源文件还在
  });

  it('复制目录需要 --recursive', async () => {
    await expect(callFs({ subcommand: 'cp', src: 'sourcedir', dst: 'copydir' }, root)).rejects.toThrow('use --recursive');
  });

  it('递归复制目录', async () => {
    const result = await callFs({ subcommand: 'cp', src: 'sourcedir', dst: 'copydir', recursive: true }, root);
    expect(result).toContain('copied:');
    expect(existsSync(join(root, 'copydir', 'nested.txt'))).toBe(true);
  });

  it('自动创建目标父目录', async () => {
    const result = await callFs({ subcommand: 'cp', src: 'source.txt', dst: 'a/b/copy.txt' }, root);
    expect(result).toContain('copied:');
    expect(existsSync(join(root, 'a/b/copy.txt'))).toBe(true);
  });

  it('源不存在时报错', async () => {
    await expect(callFs({ subcommand: 'cp', src: 'nonexistent', dst: 'dest.txt' }, root)).rejects.toThrow('source not found');
  });

  it('目标已存在时报错', async () => {
    writeFileSync(join(root, 'existing.txt'), 'existing');
    await expect(callFs({ subcommand: 'cp', src: 'source.txt', dst: 'existing.txt' }, root)).rejects.toThrow('destination already exists');
  });
});

describe('file-system tool — touch', () => {
  let root: string;

  beforeEach(() => {
    root = createSerenityInstance();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('创建空文件', async () => {
    const result = await callFs({ subcommand: 'touch', path: 'newfile.txt' }, root);
    expect(result).toBe('created empty file: newfile.txt');
    expect(existsSync(join(root, 'newfile.txt'))).toBe(true);
    expect(statSync(join(root, 'newfile.txt')).size).toBe(0);
  });

  it('更新时间戳（文件已存在）', async () => {
    writeFileSync(join(root, 'existing.txt'), 'content');
    const beforeMtime = statSync(join(root, 'existing.txt')).mtimeMs;
    // 稍等片刻确保时间戳不同
    await new Promise((r) => setTimeout(r, 10));
    const result = await callFs({ subcommand: 'touch', path: 'existing.txt' }, root);
    expect(result).toBe('updated timestamp: existing.txt');
    const afterMtime = statSync(join(root, 'existing.txt')).mtimeMs;
    expect(afterMtime).toBeGreaterThan(beforeMtime);
    // 内容不变
    expect(readFileSync(join(root, 'existing.txt'), 'utf8')).toBe('content');
  });

  it('自动创建父目录', async () => {
    const result = await callFs({ subcommand: 'touch', path: 'a/b/c/newfile.txt' }, root);
    expect(result).toBe('created empty file: a/b/c/newfile.txt');
    expect(existsSync(join(root, 'a/b/c/newfile.txt'))).toBe(true);
  });

  it('根外路径报错', async () => {
    await expect(callFs({ subcommand: 'touch', path: '/tmp/outside' }, root)).rejects.toThrow('outside serenity root');
  });
});

describe('file-system tool — 未知子命令', () => {
  let root: string;

  beforeEach(() => {
    root = createSerenityInstance();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('未知子命令报错', async () => {
    // 由于 zod 校验会在 execute 之前拦截，使用 any 绕过类型校验
    await expect(
      fileSystemTool.execute({ subcommand: 'invalid' } as any, mockCtx(root)),
    ).rejects.toThrow();
  });
});
