/**
 * msm-call.test.ts — 简化后（协议 flag / meta 路由已删除）
 *
 * 覆盖:
 * 1. resolveMsmExecScriptPath — 正确解析路径 + state 未激活时报错
 * 2. callMsmExec — 纯执行：msm_name + businessArgs 透传
 * 3. msmExecTool / msmListTool — 从 msm.ts 导出
 * 4. msmExecTool §9 fix — 错误路径保留 stdout
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('resolveMsmExecScriptPath', () => {
  let tmp: string;
  let realSerenityRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'msm-call-resolve-'));
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

describe('callMsmExec — 纯执行，无协议 flag', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'msm-call-exec-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function setupStubEnv() {
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
  }

  it('透传 msm_name + businessArgs（无协议 flag）', async () => {
    await setupStubEnv();
    const { callMsmExec } = await import('../src/util/msm-call.js');
    const result = await callMsmExec({
      msm_name: 'some-msm',
      businessArgs: ['arg1', 'arg2 with space'],
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.args).toEqual(['some-msm', 'arg1', 'arg2 with space']);
  });

  it('businessArgs 空格/特殊字符无损透传', async () => {
    await setupStubEnv();
    const { callMsmExec } = await import('../src/util/msm-call.js');
    const result = await callMsmExec({
      msm_name: 'ssh-connect',
      businessArgs: ['exec', 'ubuntu', 'ls -la | grep foo'],
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.args).toEqual(['ssh-connect', 'exec', 'ubuntu', 'ls -la | grep foo']);
  });

  it('空 businessArgs → 只传 msm_name', async () => {
    await setupStubEnv();
    const { callMsmExec } = await import('../src/util/msm-call.js');
    const result = await callMsmExec({
      msm_name: 'some-msm',
      businessArgs: [],
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.args).toEqual(['some-msm']);
  });
});

describe('msm_exec tool 注册', () => {
  it('msm.ts 导出 msmExecTool + msmListTool', async () => {
    const msm = await import('../src/msm.js');
    expect(msm.msmExecTool).toBeDefined();
    expect(msm.msmListTool).toBeDefined();
  });

  it('msm.ts 导出 msmAdminTool (合并 register/deregister)', async () => {
    const msm = await import('../src/msm.js');
    expect(msm.msmAdminTool).toBeDefined();
  });
});

describe('§9 fix: msmExecTool preserves stdout in MsmExecutionError', () => {
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

  it('exit 1 + JSON 在 stdout → 错误信息包含 JSON', async () => {
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
      (msmExecTool.execute as any)({ msm_name: 'file-rm', args: ['/nonexistent/path'] }),
    ).rejects.toThrow(/FILE_NOT_FOUND/);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (msmExecTool.execute as any)({ msm_name: 'file-rm', args: ['/nonexistent/path'] });
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

  it('exit 1 + 空 stdout + 非空 stderr → 错误信息包含 stderr', async () => {
    const stubSource = [
      '#!/usr/bin/env npx tsx',
      'process.stderr.write("plain text error from stub" + String.fromCharCode(10));',
      'process.exit(1);',
      '',
    ].join(String.fromCharCode(10));
    const { msmExecTool } = await setupToolEnv({ stubSource, msmName: 'foo' });

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (msmExecTool.execute as any)({ msm_name: 'foo', args: [] });
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

  it('exit 0 + 空 stdout → 返回 (no output)', async () => {
    const stubSource = [
      '#!/usr/bin/env npx tsx',
      'process.exit(0);',
      '',
    ].join(String.fromCharCode(10));
    const { msmExecTool } = await setupToolEnv({ stubSource, msmName: 'silent' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (msmExecTool.execute as any)({ msm_name: 'silent', args: [] });
    expect(result).toBe('(no output)');
  });
});
