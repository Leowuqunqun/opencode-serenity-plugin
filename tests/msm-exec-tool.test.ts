/**
 * msm-exec-tool.test.ts — msmExecTool 端到端测试 (S028 v0.0.3)
 *
 * 范围：
 * 1. msm.ts 导出 msmExecTool / msmListTool / msmAdminTool
 * 2. msmExecTool §9 fix 行为：exit 1 + JSON stdout / stderr-only / exit 0 + 空 stdout
 * 3. happy path E2E：完整链路 msmExecTool → msm-call → msm-exec-runtime → spawn msm
 * 4. name 不在注册表 → MsmNotRegisteredError
 *
 * 真实 E2E：cwdRoot 内放真实 stub msm 脚本 + 注册表，不 mock callMsmExec / runMsmExec。
 * 这与 msm-call.test.ts 互补：那个文件 mock 掉 msm-exec-runtime 验证 callMsmExec 行为；
 * 本文件验证 msmExecTool 与 callMsmExec 之间的契约。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// mock tui-install 避免测试时写 ~/.config/opencode/tui.json (与其他测试文件一致)
const { mockInstall, mockToPluginSpec } = vi.hoisted(() => ({
  mockInstall: vi.fn<(pluginPath: string, options?: { configPath?: string }) => { changed: boolean; configPath: string; error?: string }>(),
  mockToPluginSpec: vi.fn<(input: string) => string>((input: string) => {
    if (input.startsWith('file://')) return input;
    return `file://${input}`;
  }),
}));
vi.mock('../src/util/tui-install.js', () => ({
  ensureGlobalTuiPluginRegistration: mockInstall,
  toPluginSpec: mockToPluginSpec,
  getGlobalTuiConfigPath: () => '/tmp/mock-tui.json',
}));

const INSTANCE = 'home-serenity';

function setupRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'msm-exec-tool-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd, stdio: 'ignore' });
  // 写 /.serenity — RR1 依赖
  writeFileSync(join(cwd, '.serenity'), INSTANCE);
  // 写 SKILL.md — RR2 依赖（即使 msmExecTool 不强制，但 init-check 走它）
  const skillDir = join(cwd, '.opencode', 'skills', INSTANCE);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# test skill\n');
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

function writeStubMsm(cwd: string, msmName: string, source: string): void {
  const scriptsDir = join(cwd, '.opencode', 'skills', INSTANCE, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, msmName + '.ts'), source, 'utf8');
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', `add stub ${msmName}`], { cwd, stdio: 'ignore' });
}

function writeRegistryWithEntry(cwd: string, msmName: string, opts: { entryFlags?: Array<{ name: string; type: string; description?: string }> } = {}): void {
  const regDir = join(cwd, '.opencode', 'skills', INSTANCE, 'references');
  mkdirSync(regDir, { recursive: true });
  const entry = {
    name: msmName,
    path: `.opencode/skills/${INSTANCE}/scripts/${msmName}.ts`,
    skill: INSTANCE,
    category: 'mech',
    description: `stub ${msmName}`,
    usage: `npx tsx .opencode/skills/${INSTANCE}/scripts/${msmName}.ts`,
    flags: opts.entryFlags ?? [],
  };
  writeFileSync(
    join(regDir, 'mech-registry.json'),
    JSON.stringify({ version: 1, description: 'test registry', entries: [entry] }, null, 2),
  );
  execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', `register ${msmName}`], { cwd, stdio: 'ignore' });
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

describe('msm.ts exports (S028 v0.0.3)', () => {
  it('exports msmExecTool + msmListTool + msmAdminTool', async () => {
    const msm = await import('../src/msm.js');
    expect(msm.msmExecTool).toBeDefined();
    expect(msm.msmListTool).toBeDefined();
    expect(msm.msmAdminTool).toBeDefined();
  });
});

describe('msmExecTool §9 fix: preserves stdout/stderr in MsmExecutionError', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = setupRepo();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('exit 1 + JSON 在 stdout → 抛 MsmExecutionError 含 stdout', async () => {
    const msmName = 'file-rm';
    writeStubMsm(
      cwd,
      msmName,
      [
        '#!/usr/bin/env npx tsx',
        'const json = JSON.stringify({ ok: false, exit: 2, error: { code: "FILE_NOT_FOUND", category: "system", message: "path not found" } });',
        'process.stdout.write(json + "\\n");',
        'process.exit(1);',
        '',
      ].join('\n'),
    );
    writeRegistryWithEntry(cwd, msmName);
    await setupState(cwd);

    const { msmExecTool } = await import('../src/msm.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = (msmExecTool.execute as any)({ name: msmName, args: ['/nonexistent'] });
    await expect(promise).rejects.toThrow(/FILE_NOT_FOUND/);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (msmExecTool.execute as any)({ name: msmName, args: ['/nonexistent'] });
      throw new Error('should not reach');
    } catch (err) {
      const { MsmExecutionError } = await import('../src/errors.js');
      expect(err).toBeInstanceOf(MsmExecutionError);
      const e = err as InstanceType<typeof MsmExecutionError>;
      expect(e.exitCode).toBe(1);
      expect(e.stdout).toContain('FILE_NOT_FOUND');
      expect(e.stdout).toContain('"ok":false');
      expect(e.message).toContain('stdout:');
    }
  });

  it('exit 1 + 空 stdout + 非空 stderr → 错误信息含 stderr 不含 stdout', async () => {
    const msmName = 'foo';
    writeStubMsm(
      cwd,
      msmName,
      [
        '#!/usr/bin/env npx tsx',
        'process.stderr.write("plain text error from stub" + "\\n");',
        'process.exit(1);',
        '',
      ].join('\n'),
    );
    writeRegistryWithEntry(cwd, msmName);
    await setupState(cwd);

    const { msmExecTool } = await import('../src/msm.js');
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (msmExecTool.execute as any)({ name: msmName, args: [] });
      throw new Error('should not reach');
    } catch (err) {
      const { MsmExecutionError } = await import('../src/errors.js');
      expect(err).toBeInstanceOf(MsmExecutionError);
      const e = err as InstanceType<typeof MsmExecutionError>;
      expect(e.exitCode).toBe(1);
      expect(e.stdout).toBe('');
      expect(e.stderr).toContain('plain text error');
      expect(e.message).toContain('stderr:');
      expect(e.message).not.toContain('stdout:');
    }
  });

  it('exit 0 + 空 stdout → 返回 (no output) 字符串', async () => {
    const msmName = 'silent';
    writeStubMsm(cwd, msmName, '#!/usr/bin/env npx tsx\nprocess.exit(0);\n');
    writeRegistryWithEntry(cwd, msmName);
    await setupState(cwd);

    const { msmExecTool } = await import('../src/msm.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (msmExecTool.execute as any)({ name: msmName, args: [] });
    expect(result).toBe('(no output)');
  });
});

describe('msmExecTool happy path E2E (完整链路)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = setupRepo();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('happy path: spawn 真实 msm, 返回 stdout', async () => {
    const msmName = 'echo';
    writeStubMsm(
      cwd,
      msmName,
      [
        '#!/usr/bin/env npx tsx',
        'const args = process.argv.slice(2);',
        'process.stdout.write("echo:" + args.join(",") + "\\n");',
        '',
      ].join('\n'),
    );
    writeRegistryWithEntry(cwd, msmName);
    await setupState(cwd);

    const { msmExecTool } = await import('../src/msm.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (msmExecTool.execute as any)({ name: msmName, args: ['hello', 'world'] });
    expect(result).toBe('echo:hello,world\n');
  });
});

describe('msmExecTool 错误路径', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = setupRepo();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('name 不在注册表 → 抛 MsmNotRegisteredError', async () => {
    // 注册表为空
    const regDir = join(cwd, '.opencode', 'skills', INSTANCE, 'references');
    mkdirSync(regDir, { recursive: true });
    writeFileSync(
      join(regDir, 'mech-registry.json'),
      JSON.stringify({ version: 1, description: 'test', entries: [] }),
    );
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'empty registry'], { cwd, stdio: 'ignore' });

    await setupState(cwd);

    const { msmExecTool } = await import('../src/msm.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msmExecTool.execute as any)({ name: 'not-registered', args: [] }),
    ).rejects.toThrow(/not in mech-registry/);
  });

  it('name 在注册表但脚本文件不存在 → 业务 msm 失败 (runBusinessMsm spawn 抛错)', async () => {
    const msmName = 'ghost';
    // 只写注册表，不写脚本
    writeRegistryWithEntry(cwd, msmName);
    await setupState(cwd);

    const { msmExecTool } = await import('../src/msm.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (msmExecTool.execute as any)({ name: msmName, args: [] }),
    ).rejects.toThrow();
  });
});
