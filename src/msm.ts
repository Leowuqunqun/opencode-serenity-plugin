/**
 * msm.ts (v1.16 — Option C 简化)
 *
 * 工具集（4 个，最终）：
 * - bash (override)            : 同名覆盖 (RR3)
 * - msm_list                   : PRIMARY — 列出所有 MSM
 * - msm_exec                   : PRIMARY — 执行 MSM / 协议元命令
 * - msm_register / deregister  : (v1.17 将合并为 msm_admin，本文件保留 v1.16 拆分)
 *
 * v1.16 变更（Option C）：
 * - 删除 msm_help / msm_version / msm_schema 三个独立工具
 *   → 由 msm_exec 内部用协议 flag 拦截（--help / --version / --list / --schema）统一调度
 * - msmExecTool 砍掉 format/log 独立字段
 *   → 协议 flag 通过 args 字符串前缀传入（S022 §2.1）
 * - msmExecTool 走 parseProtocolFlags 拦截协议 flag，路由 callMsmExec / callMsmExecMeta
 * - §9 stdout 保留：MsmExecutionError stdout 字段已在 v1.15.1 落地
 *
 * v1.14 变更：msm_exec 协议层经 callMsmExec → msm-exec.ts
 * v1.13 变更：MechEntry 改由 zod schema 派生 (src/config-schema.ts)
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
import { tokenizeArgs, normalizeFlags, validatePathArgsFromTokens } from './msm-schema.js';
import {
  callMsmExec,
  callMsmExecMeta,
  parseProtocolFlags,
} from './util/msm-call.js';
import {
  parseMechRegistryFile,
  type MechEntry,
  type RegistryFile,
} from './config-schema.js';

/** v1.14: 30s 超时常量已移至 src/util/msm-call.ts
 *  旧 MSM_TIMEOUT_MS 删除 — msmExecTool 不再直接 spawn 业务 msm
 */

/** v1.13: MechEntry 改由 zod schema 派生 (src/config-schema.ts)
 *  向后兼容: 这里 re-export 一次, msm.ts 内部代码继续引用本地 type
 *  注: 不导出 MechEntry (外部不依赖此类型名)
 */

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
// v1.13: 改由 zod schema 派生 (src/config-schema.ts)
/** 保留本地 type alias 用于 msm.ts 内部使用 */
type LocalRegistryFile = RegistryFile;

function registryFilePath(cwdRoot: string, instanceName: string): string {
  return join(cwdRoot, '.opencode', 'skills', instanceName, 'references', 'mech-registry.json');
}

export function loadRegistryFile(cwdRoot: string, instanceName: string): LocalRegistryFile {
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
      return '(no MSM registered)';
    }
    return registry.map((e) => `${e.name} | ${e.skill} | ${e.category} | ${e.description}`).join('\n');
  },
});

/* ===== msm_exec tool (v1.16: 协议 flag 拦截 + meta 路由) =====
 *
 * v1.16 变更（Option C）：
 * - schema: { msm_name, args }（砍掉 v1.14 独立 format/log 字段）
 * - args 字符串前缀可含 6 协议 flag（§2.2）：
 *   --format=<text|json> --log <path> --help --version --list --schema
 * - 协议 flag 由 parseProtocolFlags 拦截：
 *   - --list / --version / --schema / --help → callMsmExecMeta
 *   - 其他 → callMsmExec (real exec)
 * - msm_name 在协议 flag 场景下：
 *   - --help / --schema 用 msm_name 作为目标 MSM
 *   - --list / --version 忽略 msm_name
 * - 业务段（含 MSM name + 业务 args）走原 callMsmExec 路径
 * - §9 修复：MsmExecutionError stdout 字段保留（v1.15.1 落地）
 */
export const msmExecTool: ToolDefinition = tool({
  description:
    '[PRIMARY] Execute a registered MSM tool or invoke a protocol meta-command. ' +
    'ALWAYS call `msm_list` first to discover the MSM name. ' +
    '**args is a CLI args string** — protocol flags (S022 RFC §2.2) are intercepted at the prefix: ' +
    '`--format=<text|json>`, `--log <path>`, `--help [name]`, `--version`, `--list`, `--schema [name]`. ' +
    'Examples: `args="--format=json /tmp/x"` for real exec; `args="--list"` for MSM listing; ' +
    '`args="--schema ssh-connect"` for a MSM schema. ' +
    '**args in real-exec mode**: rest of the string after protocol flags = business args, passed verbatim to the MSM. ' +
    '30s timeout. **Direct `bash` is disabled by serenity policy (RR3)** — msm_exec is the only path for shell work.',
  args: {
    msm_name: z.string().describe('MSM name as registered in mech-registry.json (call msm_list first). Used for real-exec; also used as the target for --help/--schema.'),
    args: z
      .string()
      .default('')
      .describe('CLI args string. Protocol flags (--format=json, --log, --help, --version, --list, --schema) at the prefix are intercepted; the rest is passed to the MSM as business args. e.g. "--format=json /tmp/x" or "--list".'),
  },
  execute: async (input) => {
    log.info('msm', 'msm_exec called', {
      msm_name: input.msm_name,
      rawArgs: input.args,
    });
    await ensureReady();
    const state = getState();

    // 1. tokenize + parse protocol flags (§2.1 拦截)
    const tokenized = input.args.trim().length === 0 ? [] : tokenizeArgs(input.args);
    const { flags, rest } = parseProtocolFlags(tokenized);

    // 2. 协议元命令路由：--list / --version / --schema / --help
    //    这些命令不需要 msm 在 registry 中，绕过 findMsm
    if (flags.list) {
      const result = await callMsmExecMeta({ kind: 'list' });
      if (result.exitCode !== 0) {
        throw new MsmExecutionError('msm-exec', result.exitCode, result.stdout, result.stderr);
      }
      return result.stdout || '(no output)';
    }
    if (flags.version) {
      const result = await callMsmExecMeta({ kind: 'version' });
      if (result.exitCode !== 0) {
        throw new MsmExecutionError('msm-exec', result.exitCode, result.stdout, result.stderr);
      }
      return result.stdout || '(no output)';
    }
    if (flags.schema) {
      // --schema 目标 msm：input.msm_name 优先，rest[0] 兜底
      const target = input.msm_name || rest[0];
      const result = await callMsmExecMeta({ kind: 'schema', msm_name: target });
      if (result.exitCode !== 0) {
        throw new MsmExecutionError(target ?? 'msm-exec', result.exitCode, result.stdout, result.stderr);
      }
      return result.stdout || '(no output)';
    }
    if (flags.help) {
      // --help 目标 msm：input.msm_name 优先，rest[0] 兜底
      const target = input.msm_name || rest[0];
      const result = await callMsmExecMeta({ kind: 'help', msm_name: target });
      if (result.exitCode !== 0) {
        throw new MsmExecutionError(target ?? 'msm-exec', result.exitCode, result.stdout, result.stderr);
      }
      return result.stdout || '(no output)';
    }

    // 3. 真实 exec 路径：先 findMsm（v1.2 path-arg 校验）
    const registry = loadMechRegistry();
    const entry = findMsm(input.msm_name, registry);
    log.info('msm', 'msm found in registry', { name: entry.name, skill: entry.skill });
    const normalized = normalizeFlags(entry.flags as Array<{ name?: string; flag?: string; type?: string }>);
    try {
      // path-arg 校验在 rest 上跑（rest 是去除协议 flag 后的业务段）
      validatePathArgsFromTokens(rest, normalized, state.cwdRoot);
    } catch (err) {
      log.warn('msm', 'msm_exec path-arg validation failed', { msm: entry.name, err: String(err) });
      throw err;
    }

    // 4. 调 msm-exec.ts（协议层 runtime）
    const result = await callMsmExec({
      msm_name: input.msm_name,
      businessArgs: rest,
      format: flags.format,
      log: flags.log,
    });
    log.info('msm', 'msm_exec result', {
      name: input.msm_name,
      exitCode: result.exitCode,
      stdoutLen: result.stdout.length,
      stderrLen: result.stderr.length,
      format: flags.format,
    });
    // v1.15.1 §9: 错误路径保留 stdout（含 JSON 模式下的 6 字段错误）
    if (result.exitCode !== 0) {
      throw new MsmExecutionError(input.msm_name, result.exitCode, result.stdout, result.stderr);
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
    'Auto-commits the registry change as "chore(msm): register <name>". ' +
    '**v1.17**: this tool will be merged with msm_deregister into msm_admin.',
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
    'Auto-commits as "chore(msm): deregister <name>". ' +
    '**v1.17**: this tool will be merged with msm_register into msm_admin.',
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

/* ===== v1.16 删除 msm_help / msm_version / msm_schema 三个独立工具 =====
 *
 * Option C 简化：原 v1.14 三个 meta 工具折叠进 msm_exec 协议 flag 拦截
 * - --list      → msm_exec({ msm_name: "<ignored>", args: "--list" })
 * - --version   → msm_exec({ msm_name: "<ignored>", args: "--version" })
 * - --schema X  → msm_exec({ msm_name: "X", args: "--schema" })
 * - --help [X]  → msm_exec({ msm_name: "X", args: "--help" })
 *
 * 历史：v1.14 RFC 落地时，meta 工具拆为 3 个独立 tool（msmHelpTool/msmVersionTool/msmSchemaTool），
 * 由 callMsmExecMeta 调度。v1.16 改回"协议 flag 拦截 + msm_exec 单入口"模型，
 * 节省 3 个 tool slot，减少 LLM 决策树宽度。
 */
