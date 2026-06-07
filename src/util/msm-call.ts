/**
 * msm-call.ts — plugin 端 msm_exec 薄包装
 *
 * 设计：将 plugin 的 msm_exec tool 调用委托给 serenity 仓 `msm-exec.ts` MSM。
 * 只做 spawn 转发——协议层（--format/--log/--list/--help 等 6 必含 flag）
 * 不再由 plugin 处理，按用户决定全部删除；msm-exec.ts 保持完整协议能力供直接 CLI 使用。
 *
 * 与 msm.ts 的 msmExecTool 关系:
 * - msmExecTool 接受 msm_name + args (string[])
 * - msmExecTool.path-arg 校验后调 callMsmExec
 * - callMsmExec 构造 spawn: npx tsx msm-exec.ts <msm_name> <business-args...>
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getState } from '../state.js';
import { MsmNotRegisteredError, MsmTimeoutError } from '../errors.js';

const MSM_TIMEOUT_MS = 600_000;

export type MsmCallOptions = {
  msm_name: string;
  /** 业务 args 数组（已按 LLM 传入，原样传递） */
  businessArgs: string[];
};

export type MsmCallResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * 解析 msm-exec.ts 的绝对路径。
 *
 * msm-exec.ts 与 mech-registry.json 在同一 skill 目录下：
 *   <cwdRoot>/.opencode/skills/<instanceName>/scripts/msm-exec.ts
 */
export function resolveMsmExecScriptPath(): string {
  const state = getState();
  const scriptPath = resolve(
    state.cwdRoot,
    '.opencode',
    'skills',
    state.instanceName,
    'scripts',
    'msm-exec.ts',
  );
  if (!existsSync(scriptPath)) {
    throw new MsmNotRegisteredError(
      `msm-exec: script not found at ${scriptPath}; ` +
        `ensure the serenity skill (${state.instanceName}) is installed and msm-exec.ts exists in its scripts/ dir`,
    );
  }
  return scriptPath;
}

/**
 * 共享 msm-exec spawn 包装
 *
 * @param scriptPath  msm-exec.ts 绝对路径
 * @param args        完整 CLI args（msm_name + 业务 args）
 * @param msmName     超时错误信息中的 msm 名（诊断友好）
 * @param cwd         spawn 工作目录
 */
function spawnMsmProcess(
  scriptPath: string,
  args: string[],
  msmName: string,
  cwd: string,
): Promise<MsmCallResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('npx', ['tsx', scriptPath, ...args], {
      cwd,
      timeout: MSM_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new MsmTimeoutError(msmName, MSM_TIMEOUT_MS));
    }, MSM_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, exitCode: code ?? 0 });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
  });
}

/**
 * 调 msm-exec.ts 执行业务 msm。
 *
 * 行为:
 * - 拼 CLI: npx tsx msm-exec.ts <msm_name> <business-args...>
 * - 无协议 flag 前缀（format/log 等由用户决定删除）
 */
export async function callMsmExec(opts: MsmCallOptions): Promise<MsmCallResult> {
  const state = getState();
  const scriptPath = resolveMsmExecScriptPath();

  return spawnMsmProcess(
    scriptPath,
    [opts.msm_name, ...opts.businessArgs],
    opts.msm_name,
    state.cwdRoot,
  );
}
