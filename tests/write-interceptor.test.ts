/**
 * WIP: Write Interceptor Protocol — 集成测试
 *
 * 覆盖场景：
 * 1. write-interceptor 未注册 → 写入继续（向后兼容）
 * 2. write-interceptor 注册且 exit 0 → 写入继续
 * 3. write-interceptor 注册且 exit 1 → 写入被拦截
 * 4. write-interceptor 注册且抛出异常 → 写入继续（fail-safe）
 * 5. edit 工具也被拦截
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const INSTANCE = 'test-ccc';

// ── 测试基础设施 ──

function setupCccRoot(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'wip-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
  writeFileSync(join(tmp, '.serenity'), INSTANCE);
  const skillDir = join(tmp, '.opencode', 'skills', INSTANCE);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# test skill');
  execFileSync('git', ['add', '-A'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: tmp, stdio: 'ignore' });
  return tmp;
}

function registerWriteInterceptor(cwd: string, scriptSource: string): void {
  const scriptsDir = join(cwd, '.opencode', 'skills', INSTANCE, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, 'write-interceptor.ts'), scriptSource);

  const regDir = join(cwd, '.opencode', 'skills', INSTANCE, 'references');
  mkdirSync(regDir, { recursive: true });
  writeFileSync(
    join(regDir, 'mech-registry.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          name: 'write-interceptor',
          path: `.opencode/skills/${INSTANCE}/scripts/write-interceptor.ts`,
          skill: INSTANCE,
          category: 'mech',
          description: 'test write interceptor',
          usage: `npx tsx .opencode/skills/${INSTANCE}/scripts/write-interceptor.ts`,
          flags: [
            { name: 'tool', type: 'string', description: 'write|edit' },
            { name: 'paths', type: 'string', description: 'comma-separated paths' },
          ],
        },
      ],
    }, null, 2),
  );
}

function allowMsm(): string {
  return [
    '#!/usr/bin/env npx tsx',
    'process.exit(0);',
  ].join('\n');
}

function blockMsm(stdoutMsg: string): string {
  return [
    '#!/usr/bin/env npx tsx',
    `console.log("${stdoutMsg}");`,
    'process.exit(1);',
  ].join('\n');
}

async function setupState(cwd: string) {
  const { resetState, setState, markReady } = await import('../src/state.js');
  resetState();
  setState({
    activated: true,
    cwdRoot: cwd,
    cccName: INSTANCE,
    skillPath: '',
    skillContent: null,
  });
  markReady();
}

// ── 测试用例 ──

describe('WIP: write-interceptor — 场景 1: 未注册（向后兼容）', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = setupCccRoot();
    // 不注册 write-interceptor — 无 mech-registry.json
    await setupState(cwd);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('write 工具 → 不抛错（无拦截器）', async () => {
    const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
    const hooks = createPermissionGuards();
    const hook = hooks['tool.execute.before']!;
    const insideFile = join(cwd, 'test.txt');
    writeFileSync(insideFile, 'data');
    await expect(
      hook({ tool: 'write', sessionID: 's', callID: 'c' } as any, { args: { filePath: insideFile } } as any),
    ).resolves.toBeUndefined();
  });

  it('edit 工具 → 不抛错（无拦截器）', async () => {
    const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
    const hooks = createPermissionGuards();
    const hook = hooks['tool.execute.before']!;
    const insideFile = join(cwd, 'test.txt');
    writeFileSync(insideFile, 'data');
    await expect(
      hook({ tool: 'edit', sessionID: 's', callID: 'c' } as any, { args: { filePath: insideFile } } as any),
    ).resolves.toBeUndefined();
  });
});

describe('WIP: write-interceptor — 场景 2: 注册且 exit 0（允许）', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = setupCccRoot();
    registerWriteInterceptor(cwd, allowMsm());
    await setupState(cwd);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('write 工具 → 不抛错（拦截器允许）', async () => {
    const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
    const hooks = createPermissionGuards();
    const hook = hooks['tool.execute.before']!;
    const insideFile = join(cwd, 'test.txt');
    writeFileSync(insideFile, 'data');
    await expect(
      hook({ tool: 'write', sessionID: 's', callID: 'c' } as any, { args: { filePath: insideFile } } as any),
    ).resolves.toBeUndefined();
  });

  it('edit 工具 → 不抛错（拦截器允许）', async () => {
    const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
    const hooks = createPermissionGuards();
    const hook = hooks['tool.execute.before']!;
    const insideFile = join(cwd, 'test.txt');
    writeFileSync(insideFile, 'data');
    await expect(
      hook({ tool: 'edit', sessionID: 's', callID: 'c' } as any, { args: { filePath: insideFile } } as any),
    ).resolves.toBeUndefined();
  });
});

describe('WIP: write-interceptor — 场景 3: 注册且 exit 1（拦截）', () => {
  let cwd: string;
  const BLOCK_REASON = 'write-interceptor: blocked for testing';

  beforeEach(async () => {
    cwd = setupCccRoot();
    registerWriteInterceptor(cwd, blockMsm(BLOCK_REASON));
    await setupState(cwd);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('write 工具 → 抛错（拦截器拒绝）', async () => {
    const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
    const hooks = createPermissionGuards();
    const hook = hooks['tool.execute.before']!;
    const insideFile = join(cwd, 'test.txt');
    writeFileSync(insideFile, 'data');
    await expect(
      hook({ tool: 'write', sessionID: 's', callID: 'c' } as any, { args: { filePath: insideFile } } as any),
    ).rejects.toThrow(BLOCK_REASON);
  });

  it('edit 工具 → 抛错（拦截器拒绝）', async () => {
    const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
    const hooks = createPermissionGuards();
    const hook = hooks['tool.execute.before']!;
    const insideFile = join(cwd, 'test.txt');
    writeFileSync(insideFile, 'data');
    await expect(
      hook({ tool: 'edit', sessionID: 's', callID: 'c' } as any, { args: { filePath: insideFile } } as any),
    ).rejects.toThrow(BLOCK_REASON);
  });

  it('拒绝时 error message 就是 MSM stdout 的内容（ACC 不加前缀）', async () => {
    const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
    const hooks = createPermissionGuards();
    const hook = hooks['tool.execute.before']!;
    const insideFile = join(cwd, 'test.txt');
    writeFileSync(insideFile, 'data');
    await expect(
      hook({ tool: 'write', sessionID: 's', callID: 'c' } as any, { args: { filePath: insideFile } } as any),
    ).rejects.toThrow(BLOCK_REASON);
    // 确认没有 ACC 前缀
    await expect(
      hook({ tool: 'write', sessionID: 's', callID: 'c' } as any, { args: { filePath: insideFile } } as any),
    ).rejects.not.toThrow(/serenity/);
  });
});

describe('WIP: write-interceptor — 场景 4: 注册但脚本文件缺失（fail-safe）', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = setupCccRoot();
    // 注册表中写入 entry 但不创建脚本文件 → callMsmExec 会抛 MsmExecError
    // 验证 fail-safe：CCC 的 MSM 出错不应阻止写入
    const regDir = join(cwd, '.opencode', 'skills', INSTANCE, 'references');
    mkdirSync(regDir, { recursive: true });
    writeFileSync(
      join(regDir, 'mech-registry.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            name: 'write-interceptor',
            path: `.opencode/skills/${INSTANCE}/scripts/write-interceptor.ts`,
            skill: INSTANCE,
            category: 'mech',
            description: 'test write interceptor (script missing)',
            usage: 'npx tsx ...',
            flags: [
              { name: 'tool', type: 'string', description: 'write|edit' },
              { name: 'paths', type: 'string', description: 'comma-separated paths' },
            ],
          },
        ],
      }, null, 2),
    );
    await setupState(cwd);
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('write 工具 → 不抛错（fail-safe 允许）', async () => {
    const { createPermissionGuards } = await import('../src/hooks/permission-guards.js');
    const hooks = createPermissionGuards();
    const hook = hooks['tool.execute.before']!;
    const insideFile = join(cwd, 'test.txt');
    writeFileSync(insideFile, 'data');
    await expect(
      hook({ tool: 'write', sessionID: 's', callID: 'c' } as any, { args: { filePath: insideFile } } as any),
    ).resolves.toBeUndefined();
  });
});
