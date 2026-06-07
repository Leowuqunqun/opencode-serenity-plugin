/**
 * msm-call.ts — plugin 端 msm_exec 协议层薄包装 (v1.14 → v1.16)
 *
 * 设计: 将 plugin 的 msm_exec tool 调用委托给 serenity 仓 `msm-exec.ts` MSM。
 * 协议层（6 必含 flag 解析、format 包装、JSON Lines 日志、stderr 6 字段 schema）
 * 由 msm-exec.ts 实施；本文件只做 spawn 转发 + 协议 flag 拦截。
 *
 * v1.16: 在 plugin 端实施 S022 RFC §2.1 协议 flag 拦截
 * - parseProtocolFlags 扫描 args 前缀段，分离协议 flag 和业务 args
 * - tool 层根据协议 flag 路由到 msm-exec.ts:
 *   - --list / --version / --schema / --help → callMsmExecMeta
 *   - 其他 → callMsmExec (real exec)
 *
 * 协议 flag 拦截位置（S022 §2.1）：
 *   协议段 = args 列表前缀连续 --flag 段
 *   第一个非 --flag token 出现 = 协议段结束
 *   业务段 = 剩余 token（= MSM 看到的 args）
 *
 * 协议 flag 未知处理：抛 InvalidProtocolFlagError 引导 LLM 重试
 * （避免业务 msm 收到协议 flag，符合 §2.1 "禁止行为"）
 *
 * 与 msm.ts 的 msmExecTool 关系:
 * - msmExecTool 接受 msm_name/args 两字段（v1.16 砍掉 format/log 独立字段）
 * - msmExecTool tokenize args → parseProtocolFlags → 路由
 * - 协议 flag 路由 → callMsmExecMeta
 * - 业务段 → callMsmExec
 *
 * 元命令（--list/--schema/--help/--version）由 msmExecTool 内部统一调度，
 * 不再单独暴露 msm_help/version/schema 工具（v1.16 Option C 简化）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getState } from '../state.js';
import { MsmNotRegisteredError, MsmTimeoutError, SerenityError } from '../errors.js';
import { tokenizeArgs } from '../msm-schema.js';

const MSM_TIMEOUT_MS = 30_000;

export type MsmCallOptions = {
  msm_name: string;
  /** 业务 args 数组（已 tokenize，不含协议 flag） */
  businessArgs: string[];
  format?: 'text' | 'json';
  log?: string;
};

export type MsmCallResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** 协议 flag 解析结果（v1.16 §2.1） */
export type ParsedProtocolFlags = {
  format: 'text' | 'json';
  log: string | undefined;
  help: boolean;
  version: boolean;
  list: boolean;
  schema: boolean;
};

const DEFAULT_PARSED_FLAGS: ParsedProtocolFlags = {
  format: 'text',
  log: undefined,
  help: false,
  version: false,
  list: false,
  schema: false,
};

/** 元命令调用（v1.16 替代原 callMsmExecMeta 多形状 union） */
export type MsmMetaCall =
  | { kind: 'list' }
  | { kind: 'version' }
  | { kind: 'help'; msm_name?: string }
  | { kind: 'schema'; msm_name?: string };

/** v1.16: 协议 flag 解析错误（引导 LLM 重试用） */
export class InvalidProtocolFlagError extends SerenityError {
  readonly flag: string;
  readonly value: string;
  readonly validValues: readonly string[];
  constructor(flag: string, value: string, validValues: readonly string[]) {
    const validStr = validValues.length > 0 ? validValues.join(' | ') : '<path>';
    super(
      `invalid protocol flag "${flag}${value ? `=${value}` : ''}"; ` +
      `valid values: ${validStr}. ` +
      `Protocol flags must be at the prefix of args (S022 RFC §2.1).`,
    );
    this.name = 'InvalidProtocolFlagError';
    this.flag = flag;
    this.value = value;
    this.validValues = validValues;
  }
}

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
 * v1.16 §2.1 协议 flag 拦截：扫描 args 前缀段
 *
 * 协议段规则（必须连续出现，且只能在 args 列表的前缀）：
 * - 段内 token 必须以 `--` 开头 OR 是 -h / -V 短别名
 * - 段结束条件：到达 args 末尾 / 遇到非上述 token / 遇到未知协议 flag
 *
 * 协议 flag 列表（S022 §2.2 6 必含 flag）：
 * - --format=<text|json> | --format <text|json>
 * - --log <path>
 * - --help / -h
 * - --version / -V
 * - --list
 * - --schema
 *
 * 未知 flag 处理：可能是 MSM 业务 flag（也以 -- 开头）→ break 协议段
 * 如果 LLM 把协议 flag 拼错（如 --formats），落到业务段会被 msm 拒绝；
 * 这是符合 S022 §2.1 复杂度低原则的设计（不预先猜未知 flag）。
 *
 * 短别名规则：仅 -h / -V 视为协议 flag（per §2.2 "禁止缩写"
 * 例外，因为 h/V 是 GNU 工具的强约定）；其他 -x 一律 break 业务段。
 *
 * 返回:
 * - flags: 解析出的协议 flag（默认值 + 已设字段）
 * - rest: 协议段之后的 token（含 MSM name + 业务 args）
 *
 * 错误（InvalidProtocolFlagError）：
 * - --format 值非 text/json
 * - --log 缺值或值为空
 * - --format 单独写但后面不是 text/json
 */
export function parseProtocolFlags(
  args: string[],
): { flags: ParsedProtocolFlags; rest: string[] } {
  const flags: ParsedProtocolFlags = { ...DEFAULT_PARSED_FLAGS };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) break;
    // 进入协议段的判定：--xxx 协议 flag 或 -h / -V 短别名
    const isShortProtocolFlag = arg === '-h' || arg === '-V';
    if (!arg.startsWith('--') && !isShortProtocolFlag) break;

    if (arg.startsWith('--format=')) {
      const v = arg.slice('--format='.length);
      if (v !== 'text' && v !== 'json') {
        throw new InvalidProtocolFlagError('--format', v, ['text', 'json']);
      }
      flags.format = v;
      i++;
    } else if (arg === '--format') {
      const v = args[++i];
      if (v !== 'text' && v !== 'json') {
        throw new InvalidProtocolFlagError('--format', v ?? '', ['text', 'json']);
      }
      flags.format = v;
      i++;
    } else if (arg === '--log') {
      const v = args[++i];
      if (typeof v !== 'string' || v === '') {
        throw new InvalidProtocolFlagError('--log', v ?? '', ['<path>']);
      }
      flags.log = v;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
      i++;
    } else if (arg === '--version' || arg === '-V') {
      flags.version = true;
      i++;
    } else if (arg === '--list') {
      flags.list = true;
      i++;
    } else if (arg === '--schema') {
      flags.schema = true;
      i++;
    } else {
      // 未知 flag — 视为业务 msm flag，break 协议段
      break;
    }
  }
  return { flags, rest: args.slice(i) };
}

/**
 * 共享 msm-exec spawn 包装（v1.18 抽 helper）
 *
 * 设计: callMsmExec / callMsmExecMeta 之前各自手写 Promise+spawn。
 * 现统一走本 helper, 保证:
 * - stdout/stderr 累积方式一致
 * - 超时处理一致（30s 硬上限, 抛 MsmTimeoutError）
 * - 错误传播一致（spawn 错误透传）
 *
 * @param scriptPath  msm-exec.ts 绝对路径
 * @param args        完整 CLI args（含协议 flag + 业务 args）
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
 * 调 msm-exec.ts 执行业务 msm（v1.16 主路径）。
 *
 * 行为:
 * - 拼 CLI: npx tsx msm-exec.ts [protocol-flags] <msm_name> <business-args>
 * - 协议 flag 按 RFC §2.2 顺序：--format=... --log <path>
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

  return spawnMsmProcess(
    scriptPath,
    [...protocolFlags, opts.msm_name, ...opts.businessArgs],
    opts.msm_name,
    state.cwdRoot,
  );
}

/**
 * 调 msm-exec.ts 执行元命令（v1.16 替代原 callMsmExecMeta 多形状 union）。
 *
 * 元命令（--list/--version/--help/--schema）由 msmExecTool 内部根据
 * parseProtocolFlags 结果路由；不再单独暴露 msm_help/version/schema 工具。
 */
export async function callMsmExecMeta(meta: MsmMetaCall): Promise<MsmCallResult> {
  const state = getState();
  const scriptPath = resolveMsmExecScriptPath();

  const flagArgs: string[] = [];
  let msmName = 'msm-exec';
  switch (meta.kind) {
    case 'list':
      flagArgs.push('--list');
      break;
    case 'version':
      flagArgs.push('--version');
      break;
    case 'help':
      flagArgs.push('--help');
      if (meta.msm_name) {
        flagArgs.push(meta.msm_name);
        msmName = meta.msm_name;
      }
      break;
    case 'schema':
      flagArgs.push('--schema');
      if (meta.msm_name) {
        flagArgs.push(meta.msm_name);
        msmName = meta.msm_name;
      }
      break;
  }

  return spawnMsmProcess(scriptPath, flagArgs, msmName, state.cwdRoot);
}

// 保留 export tokenizeArgs 以便外部 (msm.ts) 复用
export { tokenizeArgs };
