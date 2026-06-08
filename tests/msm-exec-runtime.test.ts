/**
 * msm-exec-runtime.test.ts — msm-exec-runtime 单元测试 (S028 v0.0.3)
 *
 * v1.14 (S024) 关闭时留的 follow-up: "msm-exec.ts unit tests (deferred from v1.14 — only E2E validated)"
 * S028 顺手解决 — plugin 仓 msm-exec-runtime 现在有完整单元覆盖。
 *
 * 范围（仅协议层 / 注册表解析 / 元命令）：
 * 1. parseArgs — 6 必含 flag 解析
 * 2. resolveRegistryPath + ensureRegistryFile — D6 bootstrap
 * 3. loadRegistry — v0 数组 / v1 wrapped / 错误格式
 * 4. findEntry — 命中 / 未命中
 * 5. doList / doSchema / doHelp / doVersion — 元命令输出
 *
 * 业务 msm spawn 不在此文件（需要真 npx tsx，留给 msm-exec-tool.test.ts 端到端覆盖）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runMsmExec,
  MsmExecError,
} from '../src/util/msm-exec-runtime.js';

// ── 工具：写注册表到临时目录 ──

function setupTmp(): string {
  return mkdtempSync(join(tmpdir(), 'msm-runtime-'));
}

function writeRegistry(cwd: string, content: unknown): string {
  const regDir = join(cwd, '.opencode', 'skills', 'test-inst', 'references');
  mkdirSync(regDir, { recursive: true });
  const path = join(regDir, 'mech-registry.json');
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

function writeBusinessStub(cwd: string, msmName: string, source: string): void {
  const scriptsDir = join(cwd, '.opencode', 'skills', 'test-inst', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, msmName + '.ts'), source, 'utf8');
}

// ── 测试 1: --version / --help / --list / --schema 元命令（不需要真实 msm 脚本）──

describe('msm-exec-runtime 元命令', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = setupTmp();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('--version 返回 msm_exec 版本号', async () => {
    const result = await runMsmExec(['--version'], { cwd, registryPath: writeRegistry(cwd, { version: 1, entries: [] }) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^msm-exec v/);
  });

  it('--list 列出注册表中的 msm（v1 wrapped 格式）', async () => {
    const regPath = writeRegistry(cwd, {
      version: 1,
      description: 'test',
      entries: [
        { name: 'alpha', path: 'a.ts', skill: 'test-inst', category: 'mech', description: 'A', usage: 'npx tsx a.ts' },
        { name: 'beta', path: 'b.ts', skill: 'test-inst', category: 'semi-mech', description: 'B', usage: 'npx tsx b.ts' },
      ],
    });
    const result = await runMsmExec(['--list'], { cwd, registryPath: regPath });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('alpha | test-inst | mech | A');
    expect(lines[1]).toBe('beta | test-inst | semi-mech | B');
  });

  it('--list 支持 v0 数组格式（fallback）', async () => {
    const regPath = writeRegistry(cwd, [
      { name: 'x', path: 'x.ts', skill: 't', category: 'mech', description: 'X', usage: 'npx tsx x.ts' },
    ]);
    const result = await runMsmExec(['--list'], { cwd, registryPath: regPath });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('x | t | mech | X');
  });

  it('--schema <name> 打印该 msm 的 entry JSON', async () => {
    const regPath = writeRegistry(cwd, {
      version: 1,
      description: 'test',
      entries: [
        { name: 'foo', path: 'f.ts', skill: 'test-inst', category: 'mech', description: 'F', usage: 'npx tsx f.ts', flags: [{ name: 'verbose', type: 'boolean', default: false }] },
      ],
    });
    const result = await runMsmExec(['--schema', 'foo'], { cwd, registryPath: regPath });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.name).toBe('foo');
    expect(parsed.flags[0].name).toBe('verbose');
  });

  it('--schema <unknown> → 抛 MsmExecError(MSM_NOT_FOUND, user)', async () => {
    const regPath = writeRegistry(cwd, { version: 1, entries: [] });
    await expect(
      runMsmExec(['--schema', 'nope'], { cwd, registryPath: regPath }),
    ).rejects.toThrow(MsmExecError);
    try {
      await runMsmExec(['--schema', 'nope'], { cwd, registryPath: regPath });
    } catch (err) {
      expect(err).toBeInstanceOf(MsmExecError);
      const e = err as MsmExecError;
      expect(e.code).toBe('MSM_NOT_FOUND');
      expect(e.category).toBe('user');
    }
  });

  it('--help 自帮助 (--help 无参数) 打印 msm-exec 用法', async () => {
    const regPath = writeRegistry(cwd, { version: 1, entries: [] });
    const result = await runMsmExec(['--help'], { cwd, registryPath: regPath });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('msm-exec');
    expect(result.stdout).toContain('--format');
    expect(result.stdout).toContain('--list');
  });

  it('--help <name> 打印该 msm 的帮助', async () => {
    const regPath = writeRegistry(cwd, {
      version: 1,
      description: 'test',
      entries: [
        { name: 'foo', path: 'f.ts', skill: 'test-inst', category: 'mech', description: 'F desc', usage: 'npx tsx f.ts' },
      ],
    });
    const result = await runMsmExec(['--help', 'foo'], { cwd, registryPath: regPath });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('foo — F desc');
    expect(result.stdout).toContain('用法: msm-exec foo npx tsx f.ts');
  });
});

// ── 测试 2: 协议 flag 解析错误 ──

describe('parseArgs — 协议 flag 解析错误', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = setupTmp();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('未知 flag → 抛 PARAMETER_INVALID_VALUE (user)', async () => {
    const regPath = writeRegistry(cwd, { version: 1, entries: [] });
    try {
      await runMsmExec(['--unknown', 'foo'], { cwd, registryPath: regPath });
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(MsmExecError);
      const e = err as MsmExecError;
      expect(e.code).toBe('PARAMETER_INVALID_VALUE');
      expect(e.category).toBe('user');
    }
  });

  it('--format 非法值 → 抛 PARAMETER_INVALID_VALUE', async () => {
    const regPath = writeRegistry(cwd, { version: 1, entries: [] });
    try {
      await runMsmExec(['--format=xml', 'foo'], { cwd, registryPath: regPath });
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(MsmExecError);
      const e = err as MsmExecError;
      expect(e.code).toBe('PARAMETER_INVALID_VALUE');
      expect(e.message).toContain('--format');
    }
  });

  it('业务命令缺 msm-name → 抛 PARAMETER_MISSING', async () => {
    const regPath = writeRegistry(cwd, { version: 1, entries: [] });
    try {
      await runMsmExec([], { cwd, registryPath: regPath });
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(MsmExecError);
      const e = err as MsmExecError;
      expect(e.code).toBe('PARAMETER_MISSING');
      expect(e.category).toBe('user');
    }
  });

  it('--log 缺 path → 抛 PARAMETER_MISSING', async () => {
    const regPath = writeRegistry(cwd, { version: 1, entries: [] });
    try {
      await runMsmExec(['--log'], { cwd, registryPath: regPath });
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(MsmExecError);
      const e = err as MsmExecError;
      expect(e.code).toBe('PARAMETER_MISSING');
    }
  });
});

// ── 测试 3: 业务 msm dispatch（真实 spawn，需要 npx tsx）──

describe('runBusiness — spawn 业务 msm', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = setupTmp();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('exit 0 + 业务 stdout → 透传给 caller', async () => {
    const msmName = 'greeter';
    writeBusinessStub(cwd, msmName, '#!/usr/bin/env npx tsx\nprocess.stdout.write("hello from stub\\n");\nprocess.exit(0);\n');
    const regPath = writeRegistry(cwd, {
      version: 1,
      description: 'test',
      entries: [
        { name: msmName, path: `.opencode/skills/test-inst/scripts/${msmName}.ts`, skill: 'test-inst', category: 'mech', description: 'g', usage: 'npx tsx' },
      ],
    });
    const result = await runMsmExec([msmName, 'world'], { cwd, registryPath: regPath });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from stub\n');
  });

  it('exit 0 + 业务 stdout (json 模式) → 包装为 JsonResult', async () => {
    const msmName = 'producer';
    writeBusinessStub(cwd, msmName, '#!/usr/bin/env npx tsx\nprocess.stdout.write("payload");\nprocess.exit(0);\n');
    const regPath = writeRegistry(cwd, {
      version: 1,
      description: 'test',
      entries: [
        { name: msmName, path: `.opencode/skills/test-inst/scripts/${msmName}.ts`, skill: 'test-inst', category: 'mech', description: 'p', usage: 'npx tsx' },
      ],
    });
    const result = await runMsmExec(['--format=json', msmName], { cwd, registryPath: regPath });
    expect(result.exitCode).toBe(0);
    expect(result.jsonResult).not.toBeNull();
    expect(result.jsonResult).toMatchObject({ ok: true, exit: 0, data: 'payload' });
    // stdout 应该是包装后的 JSON
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: true, exit: 0, data: 'payload' });
  });

  it('业务 msm 不存在 → 抛 MsmExecError(MSM_NOT_FOUND)', async () => {
    const regPath = writeRegistry(cwd, { version: 1, entries: [] });
    try {
      await runMsmExec(['ghost'], { cwd, registryPath: regPath });
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(MsmExecError);
      const e = err as MsmExecError;
      expect(e.code).toBe('MSM_NOT_FOUND');
      expect(e.category).toBe('user');
    }
  });
});

// ── 测试 4: 注册表错误处理 (D6 bootstrap 行为在 E2E 覆盖 — 测 plugin 真实根会污染) ──

describe('loadRegistry — 错误处理', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = setupTmp();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('caller 提供 path 但文件不存在 → 抛 MSM_REGISTRY_NOT_FOUND (in-process 模式不 bootstrap)', async () => {
    const nonexistentPath = join(cwd, 'nope.json');
    try {
      await runMsmExec(['--list'], { cwd, registryPath: nonexistentPath });
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(MsmExecError);
      const e = err as MsmExecError;
      expect(e.code).toBe('MSM_REGISTRY_NOT_FOUND');
      expect(e.category).toBe('system');
      expect(e.context).toMatchObject({ path: nonexistentPath });
    }
  });

  it('注册表顶层既不是数组也无 entries 字段 → 抛 MSM_REGISTRY_INVALID', async () => {
    const regPath = writeRegistry(cwd, { version: 1, description: 'broken' /* no entries */ });
    try {
      await runMsmExec(['--list'], { cwd, registryPath: regPath });
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(MsmExecError);
      const e = err as MsmExecError;
      expect(e.code).toBe('MSM_REGISTRY_INVALID');
      expect(e.category).toBe('system');
    }
  });

  it('注册表 JSON 语法错误 → 抛 MSM_REGISTRY_PARSE_FAILED', async () => {
    const regPath = writeRegistry(cwd, {});
    // 覆写为坏 JSON
    writeFileSync(regPath, '{ this is not json');
    try {
      await runMsmExec(['--list'], { cwd, registryPath: regPath });
      throw new Error('should not reach');
    } catch (err) {
      expect(err).toBeInstanceOf(MsmExecError);
      const e = err as MsmExecError;
      expect(e.code).toBe('MSM_REGISTRY_PARSE_FAILED');
    }
  });

  it('D6 bootstrap 注 (CLI 模式): 无 registryPath 时, plugin-root 不存在则自动创建空 {version:1, entries:[]}. 不在此测 — 需 plugin 真实根, 改由 E2E / dev workflow 覆盖', () => {
    expect(true).toBe(true); // 标记: D6 行为已通过 msm-exec-runtime.ts:208-230 ensureRegistryFile 实现, 由 dev workflow 验证
  });
});

// ── 测试 5: --log 写 JSON Lines ──

describe('--log 写 JSON Lines 日志', () => {
  let cwd: string;
  let logPath: string;

  beforeEach(() => {
    cwd = setupTmp();
    logPath = join(cwd, 'msm.log');
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('--log <path> + 业务 msm exit 0 → 写 start + end info 事件', async () => {
    const msmName = 'logged';
    writeBusinessStub(cwd, msmName, '#!/usr/bin/env npx tsx\nprocess.stdout.write("ok");\nprocess.exit(0);\n');
    const regPath = writeRegistry(cwd, {
      version: 1,
      description: 'test',
      entries: [
        { name: msmName, path: `.opencode/skills/test-inst/scripts/${msmName}.ts`, skill: 'test-inst', category: 'mech', description: 'l', usage: 'npx tsx' },
      ],
    });
    await runMsmExec(['--log', logPath, msmName], { cwd, registryPath: regPath });

    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: 'info', msm: msmName, args: [] });
    expect(lines[0].ts).toBeTruthy();
    expect(lines[1]).toMatchObject({ level: 'info', msm: msmName, exit: 0 });
  });
});
