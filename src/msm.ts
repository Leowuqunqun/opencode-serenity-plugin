/**
 * msm.ts
 *
 * 工具集（4 个）：
 * - bash (override)   : 同名覆盖 (RR3)
 * - msm_list          : PRIMARY — 列出所有 MSM
 * - msm_exec          : PRIMARY — 执行 MSM / 协议元命令
 * - msm_admin         : 注册 / 注销 MSM（合并 register/deregister）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import { log } from './util/log.js';
import {
  MsmAlreadyRegisteredError,
  MsmExecutionError,
  MsmNotInRegistryError,
  MsmNotRegisteredError,
  MsmScriptNotFoundError,
} from './errors.js';
import { getState, ensureReady } from './state.js';
import { isPathInside, gitAddAndCommit } from './util/git.js';
import { normalizeFlags, validatePathArgsFromTokens } from './msm-schema.js';
import { callMsmExec } from './util/msm-call.js';
import {
  parseMechRegistryFile,
  type MechEntry,
  type RegistryFile,
} from './config-schema.js';
import pkg from '../package.json' with { type: 'json' };

/** v0.0.3 — plugin version exposed via msmExecTool description + msmListTool output (was silent) */
const VERSION: string = pkg.version;

/** 加载 mech-registry.json（v0 简化：实例内一份） */
/** 支持两种 schema：
 *  - v1 包装格式：{ version, description, entries: [...] }
 *  - 数组格式：[...]
 * 返回统一 MechEntry[]
 */
export function loadMechRegistryFrom(cwdRoot: string, instanceName: string): MechEntry[] {
  return loadRegistryFile(cwdRoot, instanceName).entries;
}

function registryFilePath(cwdRoot: string, instanceName: string): string {
  return join(cwdRoot, '.opencode', 'skills', instanceName, 'references', 'mech-registry.json');
}

export function loadRegistryFile(cwdRoot: string, instanceName: string): RegistryFile {
  const path = registryFilePath(cwdRoot, instanceName);
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    // v1.13: 先用 zod 校验顶层结构,失败则降级为旧宽松解析
    const validated = parseMechRegistryFile(parsed);
    if (validated.success) {
      const data = validated.data;
      if (Array.isArray(data)) {
        return { entries: data, isV1Wrapped: false };
      }
      return {
        entries: data.entries,
        isV1Wrapped: true,
        version: data.version,
        description: data.description,
      };
    }
    // zod 失败 — 降级为旧逻辑 (向后兼容, 部分 v0/v1 schema 字段可能不严格)
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
      return `(serenity-plugin v${VERSION})\n(no MSM registered)`;
    }
    return `(serenity-plugin v${VERSION})\n` + registry.map((e) => `${e.name} | ${e.skill} | ${e.category} | ${e.description}`).join('\n');
  },
});

/* ===== msm_exec tool (纯执行，无协议元命令) =====
 *
 * S028 D5 极简版：只讲 msmName + args + 1 示例。
 * - 不再写"ALWAYS call msm_list first"（LLM 已知）
 * - 不再写"30s timeout"（实际 600s，runtime 内统一）
 * - 不再写"bash is disabled (RR3)"（已在 init-check / 工具面板冗余告知）
 * - 不再写"args 是 string array"（zod schema 已在 args 字段定义）
 */
export const msmExecTool: ToolDefinition = tool({
  description:
    'Execute a registered MSM tool. ' +
    'Call msm_list first to discover MSM names. ' +
    'Example: msm_name="ssh-connect", args=["exec", "ubuntu", "ls -la"]. ' +
    `(serenity-plugin v${VERSION})`,
  args: {
    msm_name: z.string().describe('MSM name as registered in mech-registry.json.'),
    args: z
      .array(z.string())
      .default([])
      .describe('Business args; each element is one argument, preserved losslessly (spaces, newlines, special chars).'),
  },
  execute: async (input) => {
    log.info('msm', 'msm_exec called', {
      msm_name: input.msm_name,
      args: input.args,
    });
    await ensureReady();
    const state = getState();

    // 1. find msm in registry
    const registry = loadMechRegistry();
    const entry = findMsm(input.msm_name, registry);
    log.info('msm', 'msm found in registry', { name: entry.name, skill: entry.skill });
    const normalized = normalizeFlags(entry.flags as Array<{ name?: string; flag?: string; type?: string }>);
    try {
      // path-arg 校验直接对 input.args（string[]）跑
      validatePathArgsFromTokens(input.args, normalized, state.cwdRoot);
    } catch (err) {
      log.warn('msm', 'msm_exec path-arg validation failed', { msm: entry.name, err: String(err) });
      throw err;
    }

    // 2. 调 msm-exec.ts（纯执行，无协议 flag）
    const result = await callMsmExec({
      msm_name: input.msm_name,
      businessArgs: input.args,
    });
    log.info('msm', 'msm_exec result', {
      name: input.msm_name,
      exitCode: result.exitCode,
      stdoutLen: result.stdout.length,
      stderrLen: result.stderr.length,
    });
    // v1.15.1 §9: 错误路径保留 stdout
    if (result.exitCode !== 0) {
      throw new MsmExecutionError(input.msm_name, result.exitCode, result.stdout, result.stderr);
    }
    return result.stdout || '(no output)';
  },
});

/* ===== v1.17 msm_admin tool（合并 msm_register + msm_deregister）=====
 *
 * 设计: 单 tool + action enum 替代两个对称 tool
 * - 减少 LLM 决策树宽度（4 tool slot → 1）
 * - action='register' | 'deregister' 强制二选一
 * - 共享核心实现：registerMsmInner / deregisterMsmInner
 *   （v1.17 从原 msmRegisterTool/msmDeregisterTool 抽出）
 *
 * 历史：
 * - v1.1 增补：msm_register + msm_deregister 两个独立 tool
 * - v1.17 合并：msm_admin 单 tool（减少 slot 占用）
 */
type RegisterInput = {
  name: string;
  path: string;
  description: string;
  category: 'mech' | 'semi-mech';
  flags: Array<{ name: string; type: string; description?: string; required?: boolean; default?: unknown }>;
  usage: string | undefined;
};

/** 内部 register 实现（v1.17 从 msmRegisterTool 抽出） */
async function registerMsmInner(input: RegisterInput): Promise<string> {
  log.info('msm', 'msm_admin register called', { name: input.name, path: input.path });
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
    throw new Error(`msm_admin: path "${input.path}" resolves to "${absPath}" which is outside cwdRoot; serenity plugin blocks path traversal`);
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
  log.info('msm', 'msm_admin register wrote registry', { name: input.name, absPath });

  // 7. 自动 commit
  const relRegistry = `.opencode/skills/${state.instanceName}/references/mech-registry.json`;
  try {
    gitAddAndCommit(state.cwdRoot, relRegistry, `chore(msm): register ${input.name}`);
  } catch (err) {
    log.warn('msm', 'git commit failed (continuing)', { err: String(err) });
  }

  return `registered "${input.name}" at ${absPath} (commit created)`;
}

type DeregisterInput = { name: string };

/** 内部 deregister 实现（v1.17 从 msmDeregisterTool 抽出） */
async function deregisterMsmInner(input: DeregisterInput): Promise<string> {
  log.info('msm', 'msm_admin deregister called', { name: input.name });
  const state = getState();

  const file = loadRegistryFile(state.cwdRoot, state.instanceName);
  const idx = file.entries.findIndex((e) => e.name === input.name);
  if (idx === -1) {
    throw new MsmNotInRegistryError(input.name);
  }

  const removed = file.entries.splice(idx, 1)[0]!;
  writeRegistryFile(state.cwdRoot, state.instanceName, file);
  log.info('msm', 'msm_admin deregister wrote registry', { name: input.name, path: removed.path });

  const relRegistry = `.opencode/skills/${state.instanceName}/references/mech-registry.json`;
  try {
    gitAddAndCommit(state.cwdRoot, relRegistry, `chore(msm): deregister ${input.name}`);
  } catch (err) {
    log.warn('msm', 'git commit failed (continuing)', { err: String(err) });
  }

  return `deregistered "${input.name}" (was at ${removed.path}; script file NOT deleted — clean up manually if needed)`;
}

export const msmAdminTool: ToolDefinition = tool({
  description:
    'Register or deregister an MSM (Mech/Semi-Mech) in mech-registry.json. ' +
    '**v1.17**: replaces the old msm_register + msm_deregister tools with a single tool + action enum. ' +
    'Auto-commits the registry change as "chore(msm): register <name>" or "chore(msm): deregister <name>".',
  args: {
    action: z
      .enum(['register', 'deregister'])
      .describe('operation to perform: register (add MSM to registry) or deregister (remove from registry)'),
    name: z
      .string()
      .min(1)
      .describe('unique MSM name (kebab-case recommended); for both register and deregister'),
    // register-specific (required when action=register, ignored otherwise)
    path: z
      .string()
      .optional()
      .describe('[register] script path, relative to cwd root (e.g. ".opencode/skills/home-serenity/scripts/foo.ts"). Required for register.'),
    description: z
      .string()
      .optional()
      .describe('[register] one-line description of what the MSM does. Required for register.'),
    category: z
      .enum(['mech', 'semi-mech'])
      .optional()
      .describe('[register] mech = pure TS, no LLM; semi-mech = TS + LLM decision points. Required for register.'),
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
      .optional()
      .describe('[register] flag schema; type:"path" enables v0.1-2 path-escape guard. Defaults to [] when omitted.'),
    usage: z
      .string()
      .optional()
      .describe('[register] one-line usage hint; default = "npx tsx <path>"'),
  },
  execute: async (input) => {
    await ensureReady();
    if (input.action === 'register') {
      if (!input.path || !input.description || !input.category) {
        throw new Error(
          'msm_admin: action=register requires path, description, category. ' +
          'deregister only needs name.',
        );
      }
      return await registerMsmInner({
        name: input.name,
        path: input.path,
        description: input.description,
        category: input.category,
        flags: input.flags ?? [],
        usage: input.usage,
      });
    }
    return await deregisterMsmInner({ name: input.name });
  },
});

/* 最终 4 tool slot：bash (override) + msm_list + msm_exec + msm_admin */
