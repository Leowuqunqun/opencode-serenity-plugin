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
function parseArgs(rawArgs: string, entry: MechEntry): string[] {
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
    'List all available MSM (Mech & Semi-Mech) tools in the current serenity instance. ' +
    'Each MSM is a deterministic, audited operation that can replace arbitrary shell commands. ' +
    '**You MUST use `msm_exec` to run an MSM** — direct `bash` is disabled by serenity policy (RR3). ' +
    'Returns one MSM per line: `name | skill | category | description`.',
  args: {},
  execute: async () => {
    // v0.1: 阻塞等待 Phase 2 完成（如果 plugin 不激活，throw 友好提示）
    try {
      await ensureReady();
    } catch (err) {
      return `serenity plugin is not active: ${err instanceof Error ? err.message : String(err)}`;
    }
    const registry = loadMechRegistry();
    if (registry.length === 0) {
      return '(no MSM registered)';
    }
    return registry.map((e) => `${e.name} | ${e.skill} | ${e.category} | ${e.description}`).join('\n');
  },
});

/* ===== msm_exec tool ===== */
export const msmExecTool: ToolDefinition = tool({
  description:
    'Execute a registered MSM tool. The MSM name must be in mech-registry.json. ' +
    'Args is a JSON object of flag→value pairs (e.g. `{"--root": true, "host": "ubuntu"}`). ' +
    '30s timeout. **Direct `bash` is disabled** by serenity policy (RR3).',
  args: {
    msm_name: z.string().describe('MSM name as registered in mech-registry.json'),
    args: z
      .string()
      .default('{}')
      .describe('JSON object of flag→value pairs; default "{}" for MSMs that take no args'),
  },
  execute: async (input) => {
    // v0.1: 阻塞等待 Phase 2 完成
    await ensureReady();
    const registry = loadMechRegistry();
    const entry = findMsm(input.msm_name, registry);
    const argv = parseArgs(input.args, entry);
    const result = await runMsm(entry, argv);
    if (result.exitCode !== 0) {
      throw new MsmExecutionError(entry.name, result.exitCode, result.stderr);
    }
    return result.stdout || '(no output)';
  },
});
