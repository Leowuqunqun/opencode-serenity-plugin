/**
 * msm_list + msm_exec 工具（RR3 核心实现）
 *
 * 读取 cwdRoot/.opencode/skills/<instanceName>/references/mech-registry.json
 * 验证 MSM 注册后才允许执行
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { log } from './util/log.js';
import {
  MsmAlreadyRegisteredError,
  MsmExecutionError,
  MsmNotInRegistryError,
  MsmNotRegisteredError,
  MsmScriptNotFoundError,
  MsmTimeoutError,
} from './errors.js';
import { getState, ensureReady } from './state.js';
import { isPathInside, gitAddAndCommit } from './util/git.js';
import { tokenizeArgs, normalizeFlags, validatePathArgsFromTokens } from './msm-schema.js';

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
/** 支持两种 schema：
 *  - v1 包装格式：{ version, description, entries: [...] }
 *  - 数组格式：[...]
 * 返回统一 MechEntry[]
 */
export function loadMechRegistryFrom(cwdRoot: string, instanceName: string): MechEntry[] {
  return loadRegistryFile(cwdRoot, instanceName).entries;
}

/** 完整 registry 文件结构（保留原 schema 用于回写）*/
export type RegistryFile = {
  entries: MechEntry[];
  isV1Wrapped: boolean;
  version?: number;
  description?: string;
};

function registryFilePath(cwdRoot: string, instanceName: string): string {
  return join(cwdRoot, '.opencode', 'skills', instanceName, 'references', 'mech-registry.json');
}

export function loadRegistryFile(cwdRoot: string, instanceName: string): RegistryFile {
  const path = registryFilePath(cwdRoot, instanceName);
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { entries: parsed as MechEntry[], isV1Wrapped: false };
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
      return {
        entries: parsed.entries as MechEntry[],
        isV1Wrapped: true,
        version: typeof parsed.version === 'number' ? parsed.version : undefined,
        description: typeof parsed.description === 'string' ? parsed.description : undefined,
      };
    }
    log.warn('msm', 'mech-registry.json 顶层既不是数组也无 entries 字段', { path });
    return { entries: [], isV1Wrapped: false };
  } catch (err) {
    log.warn('msm', 'mech-registry.json 读取/解析失败', { path, err: String(err) });
    return { entries: [], isV1Wrapped: false };
  }
}

export function writeRegistryFile(cwdRoot: string, instanceName: string, file: RegistryFile): void {
  const path = registryFilePath(cwdRoot, instanceName);
  const payload = file.isV1Wrapped
    ? {
        version: file.version ?? 1,
        description: file.description ?? 'serenity plugin: MSM registry',
        entries: file.entries,
      }
    : file.entries;
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function loadMechRegistry(): MechEntry[] {
  const state = getState();
  if (!state.activated) return [];
  return loadMechRegistryFrom(state.cwdRoot, state.instanceName);
}

/** 查找 MSM（严格相等 + 路径必须在 cwdRoot 内） */
function findMsm(name: string, registry: MechEntry[]): MechEntry {
  const entry = registry.find((e) => e.name === name);
  if (!entry) {
    throw new MsmNotRegisteredError(name);
  }
  return entry;
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
    '**args is a CLI command string** passed directly to `npx tsx <script> <args>` — same as you would type in a terminal ' +
    '(e.g. `"--check .opencode/skills/home-serenity/scripts/resolve-path.ts"` or `"--root"`). ' +
    '30s timeout. **Direct `bash` is disabled by serenity policy (RR3)** — msm_exec is the only path for shell work.',
  args: {
    msm_name: z.string().describe('MSM name as registered in mech-registry.json (call msm_list first)'),
    args: z
      .string()
      .default('')
      .describe('CLI args string, passed verbatim to `npx tsx <script> <args>`. e.g. `"--root"` or `"--host ubuntu --exec whoami"`. Leave empty "" for MSMs with no args.'),
  },
  execute: async (input) => {
    log.info('msm', 'msm_exec called', { msm_name: input.msm_name, rawArgs: input.args });
    await ensureReady();
    const state = getState();
    const registry = loadMechRegistry();
    const entry = findMsm(input.msm_name, registry);
    log.info('msm', 'msm found in registry', { name: entry.name, skill: entry.skill });

    // v1.2: tokenize CLI args + 启发式 path-arg 校验
    const argv = tokenizeArgs(input.args);
    const normalized = normalizeFlags(entry.flags as Array<{ name?: string; flag?: string; type?: string }>);
    try {
      validatePathArgsFromTokens(argv, normalized, state.cwdRoot);
    } catch (err) {
      log.warn('msm', 'msm_exec path-arg validation failed', { msm: entry.name, err: String(err) });
      throw err;
    }

    log.info('msm', 'msm_exec spawning', { name: entry.name, argv, cwd: state.cwdRoot });
    const result = await runMsm(entry, argv);
    log.info('msm', 'msm_exec result', { name: entry.name, exitCode: result.exitCode, stdoutLen: result.stdout.length, stderrLen: result.stderr.length });
    if (result.exitCode !== 0) {
      throw new MsmExecutionError(entry.name, result.exitCode, result.stderr);
    }
    return result.stdout || '(no output)';
  },
});

/* ===== msm_register tool（v1.1 增补：填补"LLM 写了 MSM 无法注册"的空白）===== */
export const msmRegisterTool: ToolDefinition = tool({
  description:
    'Register a new MSM (Mech/Semi-Mech) into mech-registry.json. ' +
    'Use this after writing a new MSM script — without registration, msm_exec cannot find it. ' +
    'Path must be relative to the serenity cwd root and the script file must already exist. ' +
    'Auto-commits the registry change as "chore(msm): register <name>".',
  args: {
    name: z.string().min(1).describe('unique MSM name (kebab-case recommended)'),
    path: z.string().min(1).describe('script path, relative to cwd root (e.g. ".opencode/skills/home-serenity/scripts/foo.ts")'),
    description: z.string().min(1).describe('one-line description of what the MSM does'),
    category: z.enum(['mech', 'semi-mech']).default('mech').describe('mech = pure TS, no LLM; semi-mech = TS + LLM decision points'),
    flags: z
      .array(
        z.object({
          name: z.string(),
          type: z.string().default('string'),
          description: z.string().optional(),
          required: z.boolean().optional(),
          default: z.unknown().optional(),
        }),
      )
      .default([])
      .describe('flag schema; type:"path" enables v0.1-2 path-escape guard'),
    usage: z.string().optional().describe('one-line usage hint; default = "npx tsx <path> --<flags>"'),
  },
  execute: async (input) => {
    log.info('msm', 'msm_register called', { name: input.name, path: input.path });
    await ensureReady();
    const state = getState();

    // 1. 读 registry（含 schema 信息）
    const file = loadRegistryFile(state.cwdRoot, state.instanceName);

    // 2. 查重
    if (file.entries.some((e) => e.name === input.name)) {
      throw new MsmAlreadyRegisteredError(input.name);
    }

    // 3. 路径必须在 cwdRoot 内
    const absPath = resolve(state.cwdRoot, input.path);
    if (!isPathInside(state.cwdRoot, absPath)) {
      throw new Error(`msm_register: path "${input.path}" resolves to "${absPath}" which is outside cwdRoot; serenity plugin blocks path traversal`);
    }

    // 4. 脚本文件必须存在
    if (!existsSync(absPath)) {
      throw new MsmScriptNotFoundError(input.name, absPath);
    }

    // 5. 构造 entry
    const usage = input.usage ?? `npx tsx ${input.path}`;
    const newEntry: MechEntry = {
      name: input.name,
      path: input.path,
      skill: state.instanceName,
      category: input.category,
      description: input.description,
      usage,
      flags: input.flags.map((f) => ({
        name: f.name,
        type: f.type,
        ...(f.description !== undefined ? { description: f.description } : {}),
        ...(f.required !== undefined ? { required: f.required } : {}),
        ...(f.default !== undefined ? { default: f.default } : {}),
      })),
    };

    // 6. 写回（保留 schema）
    file.entries.push(newEntry);
    writeRegistryFile(state.cwdRoot, state.instanceName, file);
    log.info('msm', 'msm_register wrote registry', { name: input.name, absPath });

    // 7. 自动 commit
    const relRegistry = `.opencode/skills/${state.instanceName}/references/mech-registry.json`;
    try {
      gitAddAndCommit(state.cwdRoot, relRegistry, `chore(msm): register ${input.name}`);
    } catch (err) {
      log.warn('msm', 'git commit failed (continuing)', { err: String(err) });
    }

    return `registered "${input.name}" at ${absPath} (commit created)`;
  },
});

/* ===== msm_deregister tool（v1.1 增补）===== */
export const msmDeregisterTool: ToolDefinition = tool({
  description:
    'Remove an MSM from mech-registry.json. Does NOT delete the script file (you handle that separately). ' +
    'Auto-commits as "chore(msm): deregister <name>".',
  args: {
    name: z.string().min(1).describe('MSM name to remove (must already be registered)'),
  },
  execute: async (input) => {
    log.info('msm', 'msm_deregister called', { name: input.name });
    await ensureReady();
    const state = getState();

    const file = loadRegistryFile(state.cwdRoot, state.instanceName);
    const idx = file.entries.findIndex((e) => e.name === input.name);
    if (idx === -1) {
      throw new MsmNotInRegistryError(input.name);
    }

    const removed = file.entries.splice(idx, 1)[0]!;
    writeRegistryFile(state.cwdRoot, state.instanceName, file);
    log.info('msm', 'msm_deregister wrote registry', { name: input.name, path: removed.path });

    const relRegistry = `.opencode/skills/${state.instanceName}/references/mech-registry.json`;
    try {
      gitAddAndCommit(state.cwdRoot, relRegistry, `chore(msm): deregister ${input.name}`);
    } catch (err) {
      log.warn('msm', 'git commit failed (continuing)', { err: String(err) });
    }

    return `deregistered "${input.name}" (was at ${removed.path}; script file NOT deleted — clean up manually if needed)`;
  },
});
