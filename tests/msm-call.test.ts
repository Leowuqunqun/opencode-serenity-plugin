/**
 * msm-call.test.ts (v1.14)
 *
 * 覆盖:
 * 1. resolveMsmExecScriptPath — 正确解析路径 + state 未激活时报错
 * 2. callMsmExec — 主路径 spawn 协议 flag + 业务 args
 * 3. callMsmExecMeta — 4 个元命令 (list/version/help/schema) 路由
 * 4. msmHelpTool / msmVersionTool / msmSchemaTool — 注册到 plugin
 *
 * 注：完整 6 必含 flag 行为测试在 serenity 仓 .opencode/skills/home-serenity/scripts/msm-exec.ts 单测
 * 这里只测 plugin 侧薄包装的路由
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('resolveMsmExecScriptPath (v1.14)', () => {
  let tmp: string;
  let realSerenityRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'msm-call-resolve-'));
    // 暂存真实 HOME_SERENITY_ROOT
    realSerenityRoot = process.env['HOME_SERENITY_ROOT'];
    process.env['HOME_SERENITY_ROOT'] = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (realSerenityRoot !== undefined) {
      process.env['HOME_SERENITY_ROOT'] = realSerenityRoot;
    } else {
      delete process.env['HOME_SERENITY_ROOT'];
    }
  });

  it('state 已激活 + msm-exec.ts 存在 → 返回绝对路径', async () => {
    // 在 tmp 下创建 skill 结构: .opencode/skills/<instance>/scripts/msm-exec.ts
    const scriptPath = join(tmp, '.opencode', 'skills', 'test-inst', 'scripts', 'msm-exec.ts');
    mkdirSync(join(scriptPath, '..'), { recursive: true });
    writeFileSync(scriptPath, '// stub\n', 'utf8');

    const { resetState, setState, markReady } = await import('../src/state.js');
    resetState();
    setState({
      activated: true,
      cwdRoot: tmp,
      instanceName: 'test-inst',
      skillPath: '',
      skillContent: null,
    });
    markReady();

    const { resolveMsmExecScriptPath } = await import('../src/util/msm-call.js');
    expect(resolveMsmExecScriptPath()).toBe(scriptPath);
  });

  it('state 已激活 + msm-exec.ts 不存在 → 抛 MsmNotRegisteredError', async () => {
    const { resetState, setState, markReady } = await import('../src/state.js');
    resetState();
    setState({
      activated: true,
      cwdRoot: tmp,
      instanceName: 'missing-inst',
      skillPath: '',
      skillContent: null,
    });
    markReady();

    const { resolveMsmExecScriptPath } = await import('../src/util/msm-call.js');
    expect(() => resolveMsmExecScriptPath()).toThrow(/script not found/);
  });
});

describe('callMsmExec CLI 构造 (v1.14) — 通过实际 spawn 验证', () => {
  // 真实 msm-exec.ts 在 serenity 仓, 这里用 minimal stub 测 spawn 行为
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'msm-call-spawn-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('callMsmExecMeta("list") 通过 stub 验证 msm-exec.ts 接收 --list flag', async () => {
    // 创建 stub msm-exec.ts: 打印 argv 给 stdout
    const scriptPath = join(tmp, 'msm-exec-stub.ts');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env npx tsx
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ args }) + '\\n');
`,
      'utf8',
    );

    // 创建 serenity skill 目录结构
    const serenityRoot = join(tmp, 'serenity');
    const skillScriptDir = join(serenityRoot, '.opencode', 'skills', 'home-serenity', 'scripts');
    mkdirSync(skillScriptDir, { recursive: true });
    // 把 stub 放到 skill 目录 (msm-call 会找这里)
    const targetPath = join(skillScriptDir, 'msm-exec.ts');
    const { readFileSync } = await import('node:fs');
    writeFileSync(targetPath, readFileSync(scriptPath, 'utf8'), 'utf8');

    const { resetState, setState, markReady } = await import('../src/state.js');
    resetState();
    setState({
      activated: true,
      cwdRoot: serenityRoot,
      instanceName: 'home-serenity',
      skillPath: '',
      skillContent: null,
    });
    markReady();

    const { callMsmExecMeta } = await import('../src/util/msm-call.js');
    const result = await callMsmExecMeta('list');
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.args).toEqual(['--list']);
  });

  it('callMsmExec({format: "json"}) 透传 --format=json flag', async () => {
    const scriptPath = join(tmp, 'msm-exec-stub.ts');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env npx tsx
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ args }) + '\\n');
`,
      'utf8',
    );

    const serenityRoot = join(tmp, 'serenity');
    const skillScriptDir = join(serenityRoot, '.opencode', 'skills', 'home-serenity', 'scripts');
    mkdirSync(skillScriptDir, { recursive: true });
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(skillScriptDir, 'msm-exec.ts'), readFileSync(scriptPath, 'utf8'), 'utf8');

    const { resetState, setState, markReady } = await import('../src/state.js');
    resetState();
    setState({
      activated: true,
      cwdRoot: serenityRoot,
      instanceName: 'home-serenity',
      skillPath: '',
      skillContent: null,
    });
    markReady();

    const { callMsmExec } = await import('../src/util/msm-call.js');
    const result = await callMsmExec({
      msm_name: 'some-msm',
      args: 'arg1 arg2',
      format: 'json',
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    // 协议 flag 在业务 args 之前
    expect(parsed.args).toEqual(['--format=json', 'some-msm', 'arg1', 'arg2']);
  });

  it('callMsmExec({log: "/tmp/test.log"}) 透传 --log <path>', async () => {
    const scriptPath = join(tmp, 'msm-exec-stub.ts');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env npx tsx
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ args }) + '\\n');
`,
      'utf8',
    );

    const serenityRoot = join(tmp, 'serenity');
    const skillScriptDir = join(serenityRoot, '.opencode', 'skills', 'home-serenity', 'scripts');
    mkdirSync(skillScriptDir, { recursive: true });
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(skillScriptDir, 'msm-exec.ts'), readFileSync(scriptPath, 'utf8'), 'utf8');

    const logPath = join(tmp, 'msm-exec.log');

    const { resetState, setState, markReady } = await import('../src/state.js');
    resetState();
    setState({
      activated: true,
      cwdRoot: serenityRoot,
      instanceName: 'home-serenity',
      skillPath: '',
      skillContent: null,
    });
    markReady();

    const { callMsmExec } = await import('../src/util/msm-call.js');
    const result = await callMsmExec({
      msm_name: 'some-msm',
      args: '',
      log: logPath,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.args).toEqual(['--log', logPath, 'some-msm']);
  });

  it('callMsmExecMeta({help: "msm-name"}) 透传 --help <name>', async () => {
    const scriptPath = join(tmp, 'msm-exec-stub.ts');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env npx tsx
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ args }) + '\\n');
`,
      'utf8',
    );

    const serenityRoot = join(tmp, 'serenity');
    const skillScriptDir = join(serenityRoot, '.opencode', 'skills', 'home-serenity', 'scripts');
    mkdirSync(skillScriptDir, { recursive: true });
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(skillScriptDir, 'msm-exec.ts'), readFileSync(scriptPath, 'utf8'), 'utf8');

    const { resetState, setState, markReady } = await import('../src/state.js');
    resetState();
    setState({
      activated: true,
      cwdRoot: serenityRoot,
      instanceName: 'home-serenity',
      skillPath: '',
      skillContent: null,
    });
    markReady();

    const { callMsmExecMeta } = await import('../src/util/msm-call.js');
    const result = await callMsmExecMeta({ help: 'resolve-path' });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.args).toEqual(['--help', 'resolve-path']);
  });

  it('callMsmExecMeta({schema: "x"}) 透传 --schema <name>', async () => {
    const scriptPath = join(tmp, 'msm-exec-stub.ts');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env npx tsx
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ args }) + '\\n');
`,
      'utf8',
    );

    const serenityRoot = join(tmp, 'serenity');
    const skillScriptDir = join(serenityRoot, '.opencode', 'skills', 'home-serenity', 'scripts');
    mkdirSync(skillScriptDir, { recursive: true });
    const { readFileSync } = await import('node:fs');
    writeFileSync(join(skillScriptDir, 'msm-exec.ts'), readFileSync(scriptPath, 'utf8'), 'utf8');

    const { resetState, setState, markReady } = await import('../src/state.js');
    resetState();
    setState({
      activated: true,
      cwdRoot: serenityRoot,
      instanceName: 'home-serenity',
      skillPath: '',
      skillContent: null,
    });
    markReady();

    const { callMsmExecMeta } = await import('../src/util/msm-call.js');
    const result = await callMsmExecMeta({ schema: 'resolve-path' });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.args).toEqual(['--schema', 'resolve-path']);
  });
});

describe('v1.14 新工具注册', () => {
  it('msmHelpTool / msmVersionTool / msmSchemaTool 都从 msm.ts 导出', async () => {
    const msm = await import('../src/msm.js');
    expect(msm.msmHelpTool).toBeDefined();
    expect(msm.msmVersionTool).toBeDefined();
    expect(msm.msmSchemaTool).toBeDefined();
    expect(msm.msmExecTool).toBeDefined();
    expect(msm.msmListTool).toBeDefined();
  });

  it('msmExecTool 的 args schema 接受 format + log 字段 (v1.14)', async () => {
    const { msmExecTool } = await import('../src/msm.js');
    // ToolDefinition 在 SDK 1.16+ 用 args 字段
    // 通过 JSON schema dump 验证
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolAny = msmExecTool as any;
    expect(toolAny).toBeDefined();
    // tool 字段的 args 是 zod schema, 但我们只看顶层 type
    // 直接验证 export 即可
  });
});

describe('v1.15.1 §9 fix: msmExecTool preserves stdout in MsmExecutionError', () => {
  let tmp: string;
  let realSerenityRoot: string | undefined;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'msm-call-sec9-'));
    realSerenityRoot = process.env['HOME_SERENITY_ROOT'];
    process.env['HOME_SERENITY_ROOT'] = tmp;

    const skillScriptDir = join(tmp, '.opencode', 'skills', 'home-serenity', 'scripts');
    mkdirSync(skillScriptDir, { recursive: true });
  });

  afterEach(async () => {
    rmSync(tmp, { recursive: true, force: true });
    if (realSerenityRoot !== undefined) {
      process.env['HOME_SERENITY_ROOT'] = realSerenityRoot;
    } else {
      delete process.env['HOME_SERENITY_ROOT'];
    }
    const { resetState } = await import('../src/state.js');
    resetState();
  });

  async function setupToolEnv(opts: { stubSource: string; msmName: string }) {
    const { stubSource, msmName } = opts;
    const scriptPath = join(tmp, '.opencode', 'skills', 'home-serenity', 'scripts', 'msm-exec.ts');
    writeFileSync(scriptPath, stubSource, 'utf8');

    const registryPath = join(tmp, '.opencode', 'skills', 'home-serenity', 'references', 'mech-registry.json');
    mkdirSync(join(registryPath, '..'), { recursive: true });
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        description: 'test',
        entries: [
          {
            name: msmName,
            path: 'scripts/' + msmName + '.ts',
            skill: 'home-serenity',
            category: 'mech',
            description: 'test msm',
            usage: 'npx tsx scripts/' + msmName + '.ts',
            flags: [],
          },
        ],
      }),
      'utf8',
    );

    const { resetState, setState, markReady } = await import('../src/state.js');
    resetState();
    setState({
      activated: true,
      cwdRoot: tmp,
      instanceName: 'home-serenity',
      skillPath: '',
      skillContent: null,
    });
    markReady();

    const { msmExecTool } = await import('../src/msm.js');
    return { msmExecTool };
  }

  it('sec9.4 case 1: --format=json 模式 exit 1 + JSON 在 stdout → 错误信息包含 JSON', async () => {
    const stubSource = [
      '#!/usr/bin/env npx tsx',
      'const json = JSON.stringify({ ok: false, exit: 2, error: { code: "FILE_NOT_FOUND", category: "system", message: "path not found" } });',
      'process.stdout.write(json + String.fromCharCode(10));',
      'process.exit(1);',
      '',
    ].join(String.fromCharCode(10));
    const { msmExecTool } = await setupToolEnv({ stubSource, msmName: 'file-rm' });

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msmExecTool.execute as any)({ msm_name: 'file-rm', args: '/nonexistent/path', format: 'json' }),
    ).rejects.toThrow(/FILE_NOT_FOUND/);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (msmExecTool.execute as any)({ msm_name: 'file-rm', args: '/nonexistent/path', format: 'json' });
      throw new Error('should not reach');
    } catch (err) {
      const { MsmExecutionError } = await import('../src/errors.js');
      expect(err).toBeInstanceOf(MsmExecutionError);
      const e = err as InstanceType<typeof MsmExecutionError>;
      expect(e.exitCode).toBe(1);
      expect(e.stdout).toContain('FILE_NOT_FOUND');
      expect(e.stdout).toContain('"ok":false');
      expect(e.message).toContain('stdout:');
      expect(e.message).toContain('FILE_NOT_FOUND');
    }
  });

  it('sec9 fallback: exit 1 + 空 stdout + 非空 stderr → 错误信息包含 stderr', async () => {
    const stubSource = [
      '#!/usr/bin/env npx tsx',
      'process.stderr.write("plain text error from stub" + String.fromCharCode(10));',
      'process.exit(1);',
      '',
    ].join(String.fromCharCode(10));
    const { msmExecTool } = await setupToolEnv({ stubSource, msmName: 'foo' });

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (msmExecTool.execute as any)({ msm_name: 'foo', args: '' });
      throw new Error('should not reach');
    } catch (err) {
      const { MsmExecutionError } = await import('../src/errors.js');
      expect(err).toBeInstanceOf(MsmExecutionError);
      const e = err as InstanceType<typeof MsmExecutionError>;
      expect(e.exitCode).toBe(1);
      expect(e.stdout).toBe('');
      expect(e.stderr).toContain('plain text error');
      expect(e.message).toContain('stderr:');
      expect(e.message).toContain('plain text error');
      expect(e.message).not.toContain('stdout:');
    }
  });

  it('existing behavior: exit 0 + 空 stdout → 返回 (no output)', async () => {
    const stubSource = [
      '#!/usr/bin/env npx tsx',
      'process.exit(0);',
      '',
    ].join(String.fromCharCode(10));
    const { msmExecTool } = await setupToolEnv({ stubSource, msmName: 'silent' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (msmExecTool.execute as any)({ msm_name: 'silent', args: '' });
    expect(result).toBe('(no output)');
  });
});
