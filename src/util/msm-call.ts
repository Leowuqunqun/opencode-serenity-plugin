/**
 * msm-call.ts — plugin 端 msm_exec 协议层薄包装 (v1.14)
 *
 * 设计：将 plugin 的 msm_exec tool 调用委托给 serenity 仓 `msm-exec.ts` MSM。
 * 协议层（6 必含 flag 解析、format 包装、JSON Lines 日志、stderr 6 字段 schema）
 * 由 msm-exec.ts 实施；本文件只做 spawn 转发。
 *
 * 与 msm.ts 的 msmExecTool 关系：
 * - msmExecTool 接受 msm_name/args/format/log 字段
 * - msmExecTool 调 callMsmExec（在本文件）
 * - callMsmExec 拼 CLI 后 spawn `npx tsx msm-exec.ts <protocol-flags> <msm_name> <args>`
 * - msm-exec.ts 解析协议 flag，调业务 msm，按 format/log 包装输出
 *
 * 向后兼容：
 * - 老 API（无 format/log）→ 调 msm-exec.ts 不带协议 flag → 走 text 透传
 * - 新 API（带 format=json）→ msm-exec.ts 输出 6 字段 JSON
 *
 * 元命令（--list/--schema/--help/--version）由 msmHelpTool/msmVersionTool/
 * msmSchemaTool/msmListTool 直接调 msm-exec.ts，不经过 callMsmExec。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getState } from '../state.js';
import { MsmNotRegisteredError } from '../errors.js';
import { tokenizeArgs } from '../msm-schema.js';

const MSM_TIMEOUT_MS = 30_000;

export type MsmCallOptions = {
  msm_name: string;
  args: string;
  format?: 'text' | 'json';
  log?: string;
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
 *   <cwdRoot>/.opencode/skills/<instanceName>/references/mech-registry.json
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
 * 调 msm-exec.ts 执行业务 msm（v1.14 主路径）。
 *
 * 行为：
 * - 拼 CLI: npx tsx msm-exec.ts [protocol-flags] <msm_name> <business-args>
 * - 协议 flag 按 RFC §2.2 顺序：--format=... --log <path>
 * - 业务 args 走 tokenizeArgs 拆分（支持引号）
 * - 30s 超时
 */
export async function callMsmExec(opts: MsmCallOptions): Promise<MsmCallResult> {
  const state = getState();
  const scriptPath = resolveMsmExecScriptPath();

  // 协议 flag 前缀
  const protocolFlags: string[] = [];
  if (opts.format && opts.format !== 'text') {
    protocolFlags.push(`--format=${opts.format}`);
  }
  if (opts.log) {
    protocolFlags.push('--log', opts.log);
  }

  // 业务 args
  const businessArgs = opts.args.trim().length === 0 ? [] : tokenizeArgs(opts.args);

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      'npx',
      ['tsx', scriptPath, ...protocolFlags, opts.msm_name, ...businessArgs],
      {
        cwd: state.cwdRoot,
        timeout: MSM_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

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
      rejectRun(new Error(`msm-call timeout after ${MSM_TIMEOUT_MS}ms`));
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
 * 调 msm-exec.ts 执行元命令（v1.14 新增：--list/--schema/--help/--version）。
 *
 * 与 callMsmExec 区别：
 * - 不需要 msm_name（除 --schema/--help 外）
 * - 始终 text 模式（meta 输出是给人看的）
 * - 不抛错（meta 命令失败 = 业务 msm 列表问题，让 msm-exec.ts 自己报）
 */
export async function callMsmExecMeta(
  metaFlag: 'list' | 'version' | { help: string | null } | { schema: string },
): Promise<MsmCallResult> {
  const state = getState();
  const scriptPath = resolveMsmExecScriptPath();

  const flagArgs: string[] = [];
  if (metaFlag === 'list') {
    flagArgs.push('--list');
  } else if (metaFlag === 'version') {
    flagArgs.push('--version');
  } else if ('help' in metaFlag) {
    if (metaFlag.help === null) {
      flagArgs.push('--help');
    } else {
      flagArgs.push('--help', metaFlag.help);
    }
  } else if ('schema' in metaFlag) {
    flagArgs.push('--schema', metaFlag.schema);
  }

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('npx', ['tsx', scriptPath, ...flagArgs], {
      cwd: state.cwdRoot,
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
      rejectRun(new Error(`msm-call meta timeout after ${MSM_TIMEOUT_MS}ms`));
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
