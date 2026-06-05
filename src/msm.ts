/**
 * msm_list + msm_exec 工具（RR3 核心实现）
 *
 * 读取 cwdRoot/.opencode/skills/<instanceName>/references/mech-registry.json
 * 验证 MSM 注册后才允许执行
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import {
  MsmArgsParseError,
  MsmExecutionError,
  MsmNotRegisteredError,
  MsmTimeoutError,
} from './errors.js';
import { getState, ensureReady } from './state.js';
import { isPathInside } from './util/git.js';
import { validatePathArgs } from './msm-schema.js';
import { log } from './util/log.js';

/** 30s 超时（v0 固定，v1 可配置） */
const MSM_TIMEOUT_MS = 30_000;

/** mech-registry.json 单条结构 */
type MechEntry = {
  name: string;
  path: string;
  skill: string;
  category: 'mech' | 'semi-mech';
  description: string;
  usage: string;
  flags: Array<{ name: string; type: string; description?: string; required?: boolean; default?: unknown }>;
};

/** 加载 mech-registry.json（v0 简化：实例内一份） */
function loadMechRegistry(): MechEntry[] {
  const state = getState();
  if (!state.activated) return [];
  const path = join(state.cwdRoot, '.opencode', 'skills', state.instanceName, 'references', 'mech-registry.json');
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as MechEntry[];
  } catch {
    return [];
  }
}

/** 查找 MSM（严格相等 + 路径必须在 cwdRoot 内） */
function findMsm(name: string, registry: MechEntry[]): MechEntry {
  const entry = registry.find((e) => e.name === name);
  if (!entry) {
    throw new MsmNotRegisteredError(name);
  }
  return entry;
}

/** 解析 args 字符串为 object（msm_exec 接收 string，转换为 flags） */
function parseArgs(rawArgs: string, entry: MechEntry, cwdRoot: string): string[] {
  let parsed: Record<string, unknown> = {};
  if (rawArgs.trim() === '') {
    parsed = {};
  } else {
    try {
      parsed = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new MsmArgsParseError(rawArgs, reason);
    }
  }

  // v0.1-2: path-arg 预校验（在拼 argv 之前，避免 cwdRoot 外的路径传递给 msm）
  validatePathArgs(parsed, entry, cwdRoot);

  // 转换为 --key value 形式
  const argv: string[] = [];
  for (const flag of entry.flags) {
    const value = parsed[flag.name];
    if (value === undefined) {
      if (flag.required) {
        throw new MsmArgsParseError(rawArgs, `required flag "${flag.name}" missing`);
      }
      continue;
    }
    argv.push(`--${flag.name}`);
    argv.push(String(value));
  }
  return argv;
}

/** spawn tsx 执行 MSM */
function runMsm(entry: MechEntry, argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveRun, rejectRun) => {
    const state = getState();
    // 路径必须解析到 cwdRoot 内（防路径逃逸）
    const absPath = resolve(state.cwdRoot, entry.path);
    if (!isPathInside(state.cwdRoot, absPath)) {
      rejectRun(new MsmNotRegisteredError(`${entry.name}: path "${entry.path}" escapes cwdRoot`));
      return;
    }
    const child = spawn('npx', ['tsx', absPath, ...argv], {
      cwd: state.cwdRoot,
      timeout: MSM_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectRun(new MsmTimeoutError(entry.name, MSM_TIMEOUT_MS));
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

/* ===== msm_list tool ===== */
export const msmListTool: ToolDefinition = tool({
  description:
    '[PRIMARY] List all available MSM (Mech & Semi-Mech) tools in the current serenity instance. ' +
    '**This is the FIRST tool to call for any shell/exec operation** — bash, read (path arguments), ' +
    'and most plugin tools are intentionally limited. ' +
    'Each MSM is a deterministic, audited operation registered in `mech-registry.json`. ' +
    'Returns one MSM per line: `name | skill | category | description`. ' +
    'If you need an operation that has no MSM, ask the user to register a new one before running arbitrary commands.',
  args: {},
  execute: async () => {
    log.info('msm', 'msm_list called');
    try {
      await ensureReady();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('msm', 'msm_list: plugin not active', { reason });
      return `serenity plugin is not active: ${reason}`;
    }
    const registry = loadMechRegistry();
    log.info('msm', 'msm_list result', { count: registry.length, cwdRoot: getState().cwdRoot });
    if (registry.length === 0) {
      return '(no MSM registered)';
    }
    return registry.map((e) => `${e.name} | ${e.skill} | ${e.category} | ${e.description}`).join('\n');
  },
});

/* ===== msm_exec tool ===== */
export const msmExecTool: ToolDefinition = tool({
  description:
    '[PRIMARY] Execute a registered MSM tool. ALWAYS call `msm_list` first to discover the name. ' +
    'Args is a JSON object of flag→value pairs (e.g. `{"--root": true, "host": "ubuntu"}`). ' +
    '30s timeout. **Direct `bash` is disabled by serenity policy (RR3)** — msm_exec is the only path for shell work.',
  args: {
    msm_name: z.string().describe('MSM name as registered in mech-registry.json (call msm_list first)'),
    args: z
      .string()
      .default('{}')
      .describe('JSON object of flag→value pairs; default "{}" for MSMs that take no args'),
  },
  execute: async (input) => {
    log.info('msm', 'msm_exec called', { msm_name: input.msm_name, rawArgs: input.args });
    await ensureReady();
    const state = getState();
    const registry = loadMechRegistry();
    const entry = findMsm(input.msm_name, registry);
    log.info('msm', 'msm found in registry', { name: entry.name, skill: entry.skill });
    const argv = parseArgs(input.args, entry, state.cwdRoot);
    log.info('msm', 'msm_exec spawning', { name: entry.name, argv, cwd: state.cwdRoot });
    const result = await runMsm(entry, argv);
    log.info('msm', 'msm_exec result', { name: entry.name, exitCode: result.exitCode, stdoutLen: result.stdout.length, stderrLen: result.stderr.length });
    if (result.exitCode !== 0) {
      throw new MsmExecutionError(entry.name, result.exitCode, result.stderr);
    }
    return result.stdout || '(no output)';
  },
});
