/**
 * msm-call.test.ts — S028 v0.0.3 反转 S024
 *
 * 范围：callMsmExec 自身行为（vi.mock msm-exec-runtime）
 * - argv / cwd / registryPath 透传
 * - runMsmExec 结果返回 / 错误透传 / 业务非 0 exit 透传
 * - 空 businessArgs 处理
 *
 * 不在此文件：msmExecTool 端到端 §9 测试（见 msm-exec-tool.test.ts）
 * 不在此文件：msm-exec-runtime 协议层单元测试（见 msm-exec-runtime.test.ts）
 *
 * S028 收口关键：opts.registryPath = `<cwdRoot>/.opencode/skills/<inst>/references/mech-registry.json`
 * 与 msm.ts loadMechRegistry 同一份注册表 — 避免 plugin-root vs cwdRoot 双源漂移
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vi.hoisted 让 mock factory 在 import 之前初始化（vitest 规范）
const { mockRunMsmExec } = vi.hoisted(() => ({
  mockRunMsmExec: vi.fn(),
}));

// vi.mock 替换 runMsmExec，其他 export (MsmExecError 等) 保留真实实现
vi.mock('../src/util/msm-exec-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../src/util/msm-exec-runtime.js')>(
    '../src/util/msm-exec-runtime.js',
  );
  return { ...actual, runMsmExec: mockRunMsmExec };
});

describe('callMsmExec — in-process 委托 (S028 v0.0.3)', () => {
  let tmp: string;

  beforeEach(() => {
    mockRunMsmExec.mockReset();
    tmp = mkdtempSync(join(tmpdir(), 'msm-call-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function setupState(instance = 'test-inst') {
    const { resetState, setState, markReady } = await import('../src/state.js');
    resetState();
    setState({
      activated: true,
      cwdRoot: tmp,
      instanceName: instance,
      skillPath: '',
      skillContent: null,
    });
    markReady();
  }

  it('argv = [msm_name, ...businessArgs]', async () => {
    await setupState();
    mockRunMsmExec.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0, jsonResult: null });
    const { callMsmExec } = await import('../src/util/msm-call.js');
    await callMsmExec({ msm_name: 'ssh-connect', businessArgs: ['arg1', 'arg2 with space'] });
    expect(mockRunMsmExec).toHaveBeenCalledTimes(1);
    const [argv] = mockRunMsmExec.mock.calls[0]!;
    expect(argv).toEqual(['ssh-connect', 'arg1', 'arg2 with space']);
  });

  it('空 businessArgs → argv = [msm_name]', async () => {
    await setupState();
    mockRunMsmExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, jsonResult: null });
    const { callMsmExec } = await import('../src/util/msm-call.js');
    await callMsmExec({ msm_name: 'foo', businessArgs: [] });
    const [argv] = mockRunMsmExec.mock.calls[0]!;
    expect(argv).toEqual(['foo']);
  });

  it('opts.cwd = state.cwdRoot (spawn 业务 msm 的 cwd)', async () => {
    await setupState();
    mockRunMsmExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, jsonResult: null });
    const { callMsmExec } = await import('../src/util/msm-call.js');
    await callMsmExec({ msm_name: 'foo', businessArgs: [] });
    const [, opts] = mockRunMsmExec.mock.calls[0]!;
    expect(opts?.cwd).toBe(tmp);
  });

  it('opts.registryPath = <cwdRoot>/.opencode/skills/<inst>/references/mech-registry.json (S028 收口 — 与 msm.ts 同源)', async () => {
    await setupState('my-inst');
    mockRunMsmExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0, jsonResult: null });
    const { callMsmExec } = await import('../src/util/msm-call.js');
    await callMsmExec({ msm_name: 'foo', businessArgs: [] });
    const [, opts] = mockRunMsmExec.mock.calls[0]!;
    expect(opts?.registryPath).toBe(
      join(tmp, '.opencode', 'skills', 'my-inst', 'references', 'mech-registry.json'),
    );
  });

  it('returns {stdout, stderr, exitCode} from runMsmExec (jsonResult 不暴露给 caller)', async () => {
    await setupState();
    mockRunMsmExec.mockResolvedValue({ stdout: 'hello', stderr: 'warning', exitCode: 0, jsonResult: { ok: true, exit: 0, data: 'hello' } });
    const { callMsmExec } = await import('../src/util/msm-call.js');
    const result = await callMsmExec({ msm_name: 'foo', businessArgs: [] });
    expect(result).toEqual({ stdout: 'hello', stderr: 'warning', exitCode: 0 });
  });

  it('业务 msm 非 0 exit → result.exitCode 透传 (不抛, 由 msmExecTool 转 MsmExecutionError)', async () => {
    await setupState();
    mockRunMsmExec.mockResolvedValue({ stdout: 'oops', stderr: '', exitCode: 2, jsonResult: null });
    const { callMsmExec } = await import('../src/util/msm-call.js');
    const result = await callMsmExec({ msm_name: 'foo', businessArgs: [] });
    expect(result.exitCode).toBe(2);
  });

  it('MsmExecError 透传 (协议层错误由 msmExecTool 处理, callMsmExec 不包装)', async () => {
    await setupState();
    const { MsmExecError } = await import('../src/util/msm-exec-runtime.js');
    const err = new MsmExecError('TEST_CODE', 'user', 'test error message');
    mockRunMsmExec.mockRejectedValue(err);
    const { callMsmExec } = await import('../src/util/msm-call.js');
    await expect(callMsmExec({ msm_name: 'foo', businessArgs: [] })).rejects.toBe(err);
  });

  it('非 MsmExecError 错误 (如 spawn 失败) 也透传 (caller 决定如何处理)', async () => {
    await setupState();
    const genericErr = new Error('spawn ENOENT');
    mockRunMsmExec.mockRejectedValue(genericErr);
    const { callMsmExec } = await import('../src/util/msm-call.js');
    await expect(callMsmExec({ msm_name: 'foo', businessArgs: [] })).rejects.toBe(genericErr);
  });
});
