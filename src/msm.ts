/**
 * msm.ts
 *
 * 工具集（3 个）：
 * - msm_list          : PRIMARY — 列出所有 MSM
 * - msm_exec          : PRIMARY — 执行 MSM / 协议元命令
 * - ccc_admin        : 注册 / 注销 MSM（合并 register/deregister）
 *
 * 注意：bash override (RR3) 已于 2026-06-08 移除。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import { log } from './util/log.js';
import {
  MsmAlreadyRegisteredError,
  MsmExecutionError,
  MsmNotInRegistryError,
  MsmNotRegisteredError,
  MsmPathEscapeError,
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
export function loadMechRegistryFrom(cwdRoot: string, cccName: string): MechEntry[] {
  return loadRegistryFile(cwdRoot, cccName).entries;
}

function registryFilePath(cwdRoot: string, cccName: string): string {
  return join(cwdRoot, '.opencode', 'skills', cccName, 'references', 'mech-registry.json');
}

export function loadRegistryFile(cwdRoot: string, cccName: string): RegistryFile {
  const path = registryFilePath(cwdRoot, cccName);
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

export function writeRegistryFile(cwdRoot: string, cccName: string, file: RegistryFile): void {
  const path = registryFilePath(cwdRoot, cccName);
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
  return loadMechRegistryFrom(state.cwdRoot, state.cccName);
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
    '[PRIMARY] List all available MSM (Mech & Semi-Mech) tools in the current cognitive container (CCC). ' +
    '**This is the FIRST tool to call for any shell/exec operation** — bash, read (path arguments), ' +
    'and most plugin tools are intentionally limited. ' +
    'Each MSM is a deterministic, audited operation registered in `mech-registry.json`. ' +
    'Returns one MSM per line: `name | skill | category | description`. ' +
    'MSMs with required flags show `[flags: ...]` — include these when calling msm_exec. ' +
    'If you need an operation that has no MSM, ask the user to register a new one before running arbitrary commands.',
  args: {},
  execute: async () => {
    log.info('msm', 'msm_list called');
    try {
      await ensureReady();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('msm', 'msm_list: plugin not active', { reason });
      return `CCC is not active: ${reason}`;
    }
    const state = getState();
    const registry = loadMechRegistry();
    log.info('msm', 'msm_list result', { count: registry.length, cwdRoot: state.cwdRoot });
    const header = `(serenity-plugin v${VERSION})  CCC: ${state.cccName}  Root: ${state.cwdRoot}`;
    if (registry.length === 0) {
      return `${header}\n(no MSM registered)`;
    }
    return `${header}\n` + registry.map((e) => {
      let line = `${e.name} | ${e.skill} | ${e.category} | ${e.description}`;
      if (e.flags && e.flags.length > 0) {
        const flagParts = e.flags.map((f: Record<string, unknown>) => {
          if (f.flag) return String(f.flag);
          const name = f.name ? String(f.name) : '';
          const type = f.type ? String(f.type) : 'string';
          if (type === 'boolean' || type === 'bool') return `--${name}`;
          return `--${name} <${type}>`;
        }).filter(Boolean);
        if (flagParts.length > 0) {
          line += ` [flags: ${flagParts.join(', ')}]`;
        }
      }
      return line;
    }).join('\n');
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
    'Call msm_list first to discover MSM names and descriptions. ' +
    'If unsure about required arguments, pass "--help" as the first arg to see usage. ' +
    'Example: name="ssh-connect", args=["exec", "ubuntu", "ls -la"]. ' +
    `(serenity-plugin v${VERSION})`,
  args: {
    name: z.string().describe('MSM name as registered in mech-registry.json.'),
    args: z
      .array(z.string())
      .default([])
      .describe('Business args; each element is one argument, preserved losslessly. ' +
        'Pass "--help" to discover required flags and subcommands.'),
  },
  execute: async (input) => {
    log.info('msm', 'msm_exec called', {
      msm_name: input.name,
      args: input.args,
    });
    await ensureReady();
    const state = getState();

    // 1. find msm in registry
    const registry = loadMechRegistry();
    const entry = findMsm(input.name, registry);
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
      msm_name: input.name,
      businessArgs: input.args,
    });
    log.info('msm', 'msm_exec result', {
      name: input.name,
      exitCode: result.exitCode,
      stdoutLen: result.stdout.length,
      stderrLen: result.stderr.length,
    });
    // v1.15.1 §9: 错误路径保留 stdout
    if (result.exitCode !== 0) {
      // v0.5.38: 失败时提示 agent 用 --help 发现所需参数
      const hint = input.args.includes('--help') || input.args.includes('-h')
        ? ''
        : '\n[TIP] Pass "--help" as the first arg to see this MSM\'s usage and required flags.';
      throw new MsmExecutionError(
        input.name,
        result.exitCode,
        result.stdout,
        result.stderr + hint,
      );
    }
    return result.stdout || '(no output)';
  },
});

/* ===== v1.17 ccc_admin tool（合并 msm_register + msm_deregister）=====
 *
 * 设计: 单 tool + action enum 替代两个对称 tool
 * - 减少 LLM 决策树宽度（4 tool slot → 1）
 * - action='register' | 'deregister' 强制二选一
 * - 共享核心实现：registerMsmInner / deregisterMsmInner
 *   （v1.17 从原 msmRegisterTool/msmDeregisterTool 抽出）
 *
 * 历史：
 * - v1.1 增补：msm_register + msm_deregister 两个独立 tool
 * - v1.17 合并：ccc_admin 单 tool（减少 slot 占用）
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
  log.info('msm', 'ccc_admin register called', { name: input.name, path: input.path });
  const state = getState();

  // 1. 读 registry（含 schema 信息）
  const file = loadRegistryFile(state.cwdRoot, state.cccName);

  // 2. 查重
  if (file.entries.some((e) => e.name === input.name)) {
    throw new MsmAlreadyRegisteredError(input.name);
  }

  // 3. 路径必须在 cwdRoot 内
  const absPath = input.path.startsWith('/') ? input.path : resolve(state.cwdRoot, input.path);
  if (!isPathInside(state.cwdRoot, absPath)) {
    throw new MsmPathEscapeError(input.name, 'path', input.path, absPath);
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
    skill: state.cccName,
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
  writeRegistryFile(state.cwdRoot, state.cccName, file);
  log.info('msm', 'ccc_admin register wrote registry', { name: input.name, absPath });

  // 7. 自动 commit
  const relRegistry = `.opencode/skills/${state.cccName}/references/mech-registry.json`;
  try {
    gitAddAndCommit(state.cwdRoot, relRegistry, `chore(msm): register ${input.name}`);
  } catch (err) {
    log.warn('msm', 'git commit failed (continuing)', { err: String(err) });
  }

  return `registered "${input.name}" at ${absPath} (commit created)`;
}

type DeregisterInput = { name: string };

/* ==== action=check: DC-M1~M4 品质检查 ==== */

interface MsmCheckIssue {
  check: string;
  msm: string;
  path: string;
  detail: string;
}

function scanScripts(cwdRoot: string): Array<{ name: string; path: string; skill: string }> {
  const results: Array<{ name: string; path: string; skill: string }> = [];
  const skillsDir = join(cwdRoot, '.opencode', 'skills');
  if (!existsSync(skillsDir)) return results;

  for (const skill of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!skill.isDirectory() || skill.name.startsWith('.')) continue;
    const scriptsDir = join(skillsDir, skill.name, 'scripts');
    if (!existsSync(scriptsDir)) continue;

    for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === '.gitkeep') continue;
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) continue;
      const ext = entry.name.match(/\.(ts|js|mjs)$/)?.[0];
      if (!ext) continue;
      results.push({ name: entry.name.slice(0, -ext.length), path: join(scriptsDir, entry.name), skill: skill.name });
    }
  }
  return results;
}

function checkMsmInner(): string {
  const state = getState();
  const cwdRoot = state.cwdRoot;

  const scripts = scanScripts(cwdRoot);
  const registry = loadMechRegistryFrom(cwdRoot, state.cccName);
  const registeredNames = new Set(registry.map((e) => e.name));
  const registryByPath = new Map<string, MechEntry>();
  for (const e of registry) {
    registryByPath.set(resolve(cwdRoot, e.path), e);
  }
  const issues: MsmCheckIssue[] = [];

  for (const s of scripts) {
    // DC-M1: 测试文件
    const testCandidates = [
      join(dirname(s.path), `${s.name}.test.ts`),
      join(dirname(s.path), `${s.name}.spec.ts`),
    ];
    if (!testCandidates.some((c) => existsSync(c))) {
      issues.push({ check: 'M1', msm: s.name, path: s.path, detail: '缺少单元测试文件' });
    }

    // DC-M2: main() CLI 守卫
    try {
      const content = readFileSync(s.path, 'utf-8');
      const hasMain = /\bfunction\s+main\s*\(/.test(content);
      const hasGuard = /isMain|require\.main\s*===|import\.meta\.url/.test(content);
      if (!hasMain && !hasGuard) {
        issues.push({ check: 'M2', msm: s.name, path: s.path, detail: '缺少 main() CLI 守卫（直接 import 可能触发副作用）' });
      }
    } catch {
      // skip unreadable
    }

    // DC-M3: 已注册
    if (!registeredNames.has(s.name)) {
      issues.push({ check: 'M3', msm: s.name, path: s.path, detail: '未在 mech-registry.json 注册' });
    }

    // DC-M4: 路径参数标记
    const entry = registryByPath.get(s.path);
    if (entry && entry.flags) {
      for (const f of entry.flags) {
        if (!('name' in f && 'type' in f)) continue;
        const fname = f.name.toLowerCase();
        const hasPathHint = fname.includes('path') || fname.includes('file') || fname.includes('dir');
        if (hasPathHint && f.type !== 'path') {
          issues.push({ check: 'M4', msm: s.name, path: s.path, detail: `flag "${f.name}" 疑似路径参数但未标记 type:"path"` });
        }
      }
    }
  }

  // DC-M3 反向: 注册表中脚本缺失
  for (const entry of registry) {
    const abs = resolve(cwdRoot, entry.path);
    if (!existsSync(abs)) {
      issues.push({ check: 'M3', msm: entry.name, path: entry.path, detail: 'mech-registry.json 引用但脚本文件不存在' });
    }
  }

  if (issues.length === 0) return `MSM quality check: ALL ${scripts.length} MSM(s) passed (M1-M4).`;

  const lines = [
    `MSM quality check: ${scripts.length} MSM(s), ${issues.length} issue(s)`,
    ...issues.map((i) => `  [${i.check}] ${i.msm} — ${i.detail}`),
  ];
  return lines.join('\n');
}

/** 内部 deregister 实现（v1.17 从 msmDeregisterTool 抽出） */
async function deregisterMsmInner(input: DeregisterInput): Promise<string> {
  log.info('msm', 'ccc_admin deregister called', { name: input.name });
  const state = getState();

  const file = loadRegistryFile(state.cwdRoot, state.cccName);
  const idx = file.entries.findIndex((e) => e.name === input.name);
  if (idx === -1) {
    throw new MsmNotInRegistryError(input.name);
  }

  const removed = file.entries.splice(idx, 1)[0]!;
  writeRegistryFile(state.cwdRoot, state.cccName, file);
  log.info('msm', 'ccc_admin deregister wrote registry', { name: input.name, path: removed.path });

  const relRegistry = `.opencode/skills/${state.cccName}/references/mech-registry.json`;
  try {
    gitAddAndCommit(state.cwdRoot, relRegistry, `chore(msm): deregister ${input.name}`);
  } catch (err) {
    log.warn('msm', 'git commit failed (continuing)', { err: String(err) });
  }

  return `deregistered "${input.name}" (was at ${removed.path}; script file NOT deleted — clean up manually if needed)`;
}

export const msmAdminTool: ToolDefinition = tool({
  description:
    'CCC MSM (Mech & Semi-Mech) 注册表管理工具。' +
    '维护当前 CCC 的 mech-registry.json，支持注册/注销 MSM、获取开发手册、运行品质检查、查看 CCC 配置。' +
    'action=register：注册新 MSM（需 name/path/description/category），自动 git commit。' +
    'action=deregister：注销 MSM，自动 git commit。' +
    'action=guide：MSM 开发手册（脚本规范、测试、注册约定）。' +
    'action=check：对全部 MSM 脚本运行 DC-M1~M4 品质检查。' +
    'action=ccc-config：输出 CCC 配置参考——.opencode/serenity.json 中 loop.defaultModel / sessionKeeper.threshold / safeMode.blacklist 的具体 JSON 写法与示例。',
  args: {
    action: z
      .enum(['register', 'deregister', 'guide', 'check', 'ccc-config'])
      .describe('operation: register (add MSM), deregister (remove), guide (show development handbook), check (run DC-M1~M4 quality checks), ccc-config (get CCC config reference with concrete JSON examples)'),
    name: z
      .string()
      .optional()
      .describe('unique MSM name (kebab-case recommended); for register and deregister'),
    path: z
      .string()
      .optional()
      .describe('[register] script path, relative to cwd root. Required for register.'),
    description: z
      .string()
      .optional()
      .describe('[register] one-line description. Required for register.'),
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
      .describe('[register] flag schema; type:"path" enables path-escape guard. Defaults to [] when omitted.'),
    usage: z
      .string()
      .optional()
      .describe('[register] one-line usage hint; default = "npx tsx <path>"'),
  },
  execute: async (input) => {
    await ensureReady();
    if (input.action === 'guide') {
      const state = getState();
      const guidePath = join(state.cwdRoot, 'docs', 'msm-development-guide.md');
      try {
        return readFileSync(guidePath, 'utf8');
      } catch {
        // fallback: embedded compact guide
        return [
          '=== MSM Development Handbook (compact) ===',
          'Full guide not found at docs/msm-development-guide.md.',
          '',
          'Directory: skill-name/scripts/',
          '  ├── my-msm.ts        ← implementation',
          '  └── my-msm.test.ts   ← unit test (mandatory, checked by SQC DC-M1)',
          '',
          'Interface design (EAP-driven):',
          '  • Use full semantic names: --template-path not --tp',
          '  • One flag = one concept; no JSON blobs',
          '  • Flag count ≤ 5; use subcommands for complex operations',
          '  • Prefer precise types: path/number/boolean over string',
          '  • Flag name itself carries meaning — description only adds precision',
          '',
          'Flag schema (v1):',
          '  { "flags": [',
          '    { "flag": "--host <IP地址>", "description": "target server" },',
          '    { "flag": "--port <端口>",   "description": "port, default 22" },',
          '    { "flag": "--dry-run",       "description": "preview, no execution" }',
          '  ] }',
          '',
          'Script requirements:',
          '  • main() CLI guard (prevents vitest trigger)',
          '  • stdout = business output, stderr = errors',
          '  • Path args → flag name or description must contain path/file/dir',
          '',
          'Register: ccc_admin register --name <name> --path <path>',
          '  --description "<desc>" --category mech|semi-mech',
          '',
          'SQC checks: DC-M1 (test file), DC-M2 (main guard), DC-M3 (registered), DC-M4 (path flags)',
        ].join('\n');
      }
    }
    if (input.action === 'check') {
      return checkMsmInner();
    }

    if (input.action === 'ccc-config') {
      return [
        '═══ CCC Configuration Reference ═══',
        '',
        'CCC-level features are configured in `.opencode/serenity.json`.',
        'Below are all available configuration sections.',
        '',
        '',
        '── 1. loop.defaultModel ──',
        '',
        'loop 工具 headless 会话的默认模型。',
        '设置后 loop 无需显式传 --model 参数。',
        '',
        '  配置：',
        '    { "loop": { "defaultModel": "provider/model-name" } }',
        '',
        '  示例：',
        '    { "loop": { "defaultModel": "opencode-go/deepseek-v4-flash" } }',
        '',
        '  未配置时：loop 工具报错，要求显式 --model 或先配置 defaultModel。',
        '',
        '',
        '── 2. sessionKeeper.threshold ──',
        '',
        'Session-Keeper 提醒机制的积分阈值（非 headless 主 agent 会话）。',
        '跟踪工具调用（加权）和经过时间；score 达到 threshold 时注入提醒，',
        '要求模型回 ACK code。',
        '',
        '  配置：',
        '    { "sessionKeeper": { "threshold": 100 } }',
        '',
        '  计分公式：tool_score + elapsed_minutes_since_last_reset',
        '    write/edit = 3 分，task = 10 分，read/grep/glob/msm 等 = 1 分',
        '    时间 = 1 分/分钟',
        '  默认值：150',
        '  说明：',
        '    - 阈值越低，提醒越频繁；0 表示每轮都触发',
        '    - 达到阈值后注入提醒，直至收到正确 code 的 ACK 才清零',
        '',
        '',
        '── 3. safeMode.blacklist ──',
        '',
        'Safe Mode 启用时包含两层保护：',
        '  - bash 工具被禁用',
        '  - write/edit 到黑名单路径被拦截',
        '',
        '切换方式：TUI 斜杠命令 /serenity-safe-mode on|off|status，',
        '或创建/删除 CCC 根目录的 `.serenity-safe-on` 标记文件。',
        '',
        '  blacklist 数组内每条可以是字符串或对象：',
        '',
        '  A. 字符串形式（前缀或正则）：',
        '    "/etc/"            — 前缀匹配，拦截以 /etc/ 开头的路径',
        '    "regex:\.secret/"  — 正则匹配（regex: 前缀），拦截含 .secret/ 的路径',
        '',
        '  B. 对象形式（可带自定义拦截原因）：',
        '    {',
        '      "pattern": "/etc/",',
        '      "message": "禁止修改系统目录 /etc/"',
        '    }',
        '    - pattern：必填，规则同字符串形式（前缀或 regex: 前缀）',
        '    - message：可选。命中该条时抛出的拦截提示，用于告知拦截原因；',
        '      不设置时使用默认提示：',
        '      [serenity] <tool> to "<path>" is not allowed.',
        '',
        '  匹配规则：',
        '    - 前缀匹配：路径以 pattern 开头即命中',
        '    - 正则匹配：RegExp 对路径执行 test，命中即拦截',
        '    - 非法条目（非字符串、缺 pattern、空 regex）自动过滤',
        '',
        '  完整示例：',
        '    {',
        '      "safeMode": {',
        '        "blacklist": [',
        '          "/etc/",',
        '          { "pattern": "regex:\.secret/", "message": "禁止写入 .secret 目录" },',
        '          { "pattern": "/root/", "message": "不允许修改 root 用户文件" }',
        '        ]',
        '      }',
        '    }',
        '',
        '  Safe Mode 默认：TUI 关闭，server 模式开启。',
        '  兼容旧标记：`.serenity-bash-off` 视同 safe mode 开启。',
        '',
        '',
        '── 配置文件位置 ──',
        '',
        '所有配置集中在单文件：',
        '  <CCC-root>/.opencode/serenity.json',
        '',
        '包含全部选项的完整示例：',
        '',
        '  {',
        '    "loop": {',
        '      "defaultModel": "opencode-go/deepseek-v4-flash"',
        '    },',
        '    "sessionKeeper": {',
        '      "threshold": 100',
        '    },',
        '    "safeMode": {',
        '      "blacklist": [',
        '        "/etc/",',
        '        { "pattern": "regex:\.secret/", "message": "禁止写入 .secret 目录" }',
        '      ]',
        '    }',
        '  }',
      ].join('\n');
    }
    if (input.action === 'register') {
      if (!input.name || !input.path || !input.description || !input.category) {
        throw new Error(
          'ccc_admin: action=register requires name, path, description, category. '
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
    if (!input.name) {
      throw new Error('ccc_admin: action=deregister requires name');
    }
    return await deregisterMsmInner({ name: input.name });
  },
});

/* 最终 4 tool slot：bash (override) + msm_list + msm_exec + ccc_admin */
