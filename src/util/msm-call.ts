/**
 * msm-call.ts — plugin 端 msm_exec in-process 委托 (S028)
 *
 * 设计：将 plugin 的 msm_exec tool 调用委托给 plugin 仓内 msm-exec-runtime
 * (零 spawn, 零外部依赖). S028 反转 S024/D26, plugin 完全自包含.
 *
 * 历史：
 * - v0.0.2 (S024 v1.14): 薄包装, spawn serenity 仓 msm-exec.ts
 * - v0.0.3 (S028): in-process 委托 plugin 仓内 msm-exec-runtime
 *
 * 与 msm.ts 的 msmExecTool 关系:
 * - msmExecTool 接受 msm_name + args (string[])
 * - msmExecTool 在 cwdRoot 注册表 path 1 校验 entry, path-arg 校验
 * - msmExecTool 调 callMsmExec({msm_name, businessArgs})
 * - callMsmExec 计算 path 1 (与 msm.ts 同源) 传给 runMsmExec
 * - runMsmExec 用同一份注册表查找 msm + spawn 业务
 *
 * S028 v0.0.3 收口:
 * - 业务流统一走 cwdRoot 注册表 (避免 plugin-root vs cwd-root 双源漂移)
 * - plugin-root 注册表仅供 CLI 调试 (D9/D10/D6 保留为 fallback, msm-exec-runtime 自动 bootstrap)
 */

import { join } from 'node:path';
import { runMsmExec, MsmExecError } from './msm-exec-runtime.js';
import { getState } from '../state.js';
import { MsmTimeoutError } from '../errors.js';

/** 与 v0.0.2 一致的 10 分钟超时 (S028 D11 统一) */
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
 * 计算 cwdRoot 注册表绝对路径（与 msm.ts:43 registryFilePath 一致）
 * 单一文件路径常量集中处。S028 v0.0.3 收口:
 * - msm.ts loadMechRegistry 用此路径
 * - msm-call runMsmExec 用此路径 (新)
 * - 两处同源, 不再有双注册表漂移风险
 */
function registryFilePath(cwdRoot: string, instanceName: string): string {
  return join(cwdRoot, '.opencode', 'skills', instanceName, 'references', 'mech-registry.json');
}

/**
 * 调 msm_exec in-process (S028).
 *
 * 行为:
 * - 直接 import plugin 仓 msm-exec-runtime.runMsmExec
 * - 不 spawn 协议层子进程 (运行时本身就是 in-process 库函数)
 * - 业务 msm spawn 内部由 runtime 完成, cwd = state.cwdRoot
 * - 注册表路径 = cwdRoot 注册表 (与 msm.ts loadMechRegistry 同源)
 * - 600s 超时 (与 v0.0.2 行为一致, 10 分钟)
 *
 * 错误映射:
 * - 协议错误 (MsmExecError): 透传给 caller (msmExecTool 捕获并转 MsmExecutionError)
 * - 超时: 抛 MsmTimeoutError (与 v0.0.2 行为一致)
 * - 业务 msm 非 0 exit: 不抛, 通过 result.exitCode 透传 (msmExecTool 转 MsmExecutionError)
 */
export async function callMsmExec(opts: MsmCallOptions): Promise<MsmCallResult> {
  const state = getState();

  // 拼 argv: <msm_name> <business-args...>
  const argv = [opts.msm_name, ...opts.businessArgs];
  const registryPath = registryFilePath(state.cwdRoot, state.instanceName);

  // 用 Promise.race 加超时 (与 v0.0.2 行为一致, 600s)
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new MsmTimeoutError(opts.msm_name, MSM_TIMEOUT_MS)),
      MSM_TIMEOUT_MS,
    );
  });

  try {
    const result = await Promise.race([
      runMsmExec(argv, { cwd: state.cwdRoot, registryPath }),
      timeoutPromise,
    ]);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (err) {
    if (err instanceof MsmExecError) {
      // 协议错误透传 (msmExecTool 处理)
      throw err;
    }
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}
