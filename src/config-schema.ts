/**
 * config-schema.ts — v1.13 zod-first plugin config
 *
 * 设计目标 (D26 决策 — 仿 omo OhMyOpenCodeConfig 模式):
 * - zod schema 作为单一真相源（single source of truth）
 * - TS 类型由 z.infer 派生（避免手写 interface 与 schema 重复）
 * - 公开 parseConfig / safeParseConfig 给配置加载/校验场景
 * - 保留 v1.11 之前的所有 type export (向后兼容, 公共 API 不变)
 *
 * 迁移范围 (v1.13):
 * - MechEntry (msm.ts 内) — zod schema 化
 * - HookConfig (hooks/util.ts 内) — zod schema 化 (轻量, catchall boolean)
 * - 新增 PluginConfig — 用户面向配置 (omo 风格, 启用/禁用 hooks/tools/mcps + 协议层选项)
 *
 * 不在 v1.13 范围 (D26 §3 锁定):
 * - PluginConfig 的实际消费 (parseConfig 在 plugin 入口接线) — 留 v1.15
 * - 把 PluginConfig 写入 opencode.json — 留 v1.15
 * - PluginConfig 与 msm-exec 协议 flag 联动 (msm_exec_format / msm_exec_log) — 留 v1.15
 *
 * 与 v0.2 msm-writing-standards §5 兼容:
 * - 错误处理走 zod.ZodError (6 字段 schema 友好)
 * - safeParseConfig 返回 { success, data, error } 模式（不抛错给调用方）
 */

import { z, type ZodError } from 'zod';
import type { Hooks } from '@opencode-ai/plugin';

/**
 * Plugin 当前注入到 opencode 的 hook 名清单 (v1.18 单一真相源)
 *
 * 与 Hooks (来自 @opencode-ai/plugin) 的子集保持一致 — `satisfies` 保证
 * 此处列出的每一项都是 opencode 真实存在的 hook。
 *
 * 维护规则：新增 hook 时先在此处加常量，再在 createXxxHooks 工厂里用。
 */
export const HOOK_NAMES = [
  'shell.env',
  'tool.execute.before',
  'tool.definition',
  'experimental.chat.system.transform',
  'experimental.session.compacting',
] as const satisfies readonly (keyof Hooks)[];

/** hook 名类型（HOOK_NAMES 元素的 union） */
export type HookName = (typeof HOOK_NAMES)[number];

// ── MechEntry (msm.ts 内迁移) ──

/**
 * flag schema: 兼容 v0 schema (name/type) 和 v1 schema (flag/description)
 * 见 msm-schema.ts 的 normalizeFlag 逻辑
 */
export const mechFlagSchema = z.union([
  z.object({
    name: z.string(),
    type: z.string().default('string'),
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  }),
  z.object({
    flag: z.string(),
    description: z.string().optional(),
  }),
]);

/** mech-registry.json 单条 entry schema (v1 包装格式) */
export const mechEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  skill: z.string().min(1),
  category: z.enum(['mech', 'semi-mech']),
  description: z.string().min(1),
  usage: z.string(),
  subcommands: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        args: z
          .array(
            z.object({
              name: z.string(),
              type: z.string(),
              required: z.boolean().optional(),
              description: z.string().optional(),
            }),
          )
          .optional(),
        flags: z
          .array(
            z.object({
              name: z.string(),
              type: z.string(),
              default: z.unknown().optional(),
              description: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  flags: z.array(mechFlagSchema).default([]),
  exit_codes: z.record(z.string(), z.string()).optional(),
  error_codes: z.array(z.string()).optional(),
});

/** 派生 TS 类型 (替代原 msm.ts 内手写 type MechEntry) */
export type MechEntry = z.infer<typeof mechEntrySchema>;

/** 注册表顶层 schema */
export const mechRegistryFileSchema = z.union([
  z.array(mechEntrySchema),
  z.object({
    version: z.number().optional(),
    description: z.string().optional(),
    entries: z.array(mechEntrySchema),
  }),
]);

export type MechRegistryFile = z.infer<typeof mechRegistryFileSchema>;

/** RegistryFile 包装 (msm.ts 内迁移, v1 包装/数组双格式) */
export const registryFileSchema = z.object({
  entries: z.array(mechEntrySchema),
  isV1Wrapped: z.boolean(),
  version: z.number().optional(),
  description: z.string().optional(),
});

export type RegistryFile = z.infer<typeof registryFileSchema>;

// ── HookConfig (hooks/util.ts 内迁移) ──

/**
 * HookConfig = 部分 hook 启用/禁用 map
 *
 * 关键：key 必须是 HOOK_NAMES 之一 (单一真相源, v1.18 统一)
 * value 是 boolean (false = 禁用, 缺省/true = 启用)
 *
 * 实现：z.object 显式列出每个 HOOK_NAME 为 optional boolean。
 * - 严格 key 校验（zod 4 的 z.record(K, V) 行为不稳定, 此方案最稳）
 * - 旧用法（如 `{'shell.env': false}`）仍兼容
 * - 严格模式会拒绝拼错 hook 名
 */
export const hookConfigSchema = z
  .object(
    Object.fromEntries(
      HOOK_NAMES.map((name) => [name, z.boolean().optional()]),
    ) as { [K in HookName]?: z.ZodOptional<z.ZodBoolean> },
  )
  .describe('per-hook enable/disable map; key = HookName, value = false = disabled');

/** 派生 TS 类型 */
export type HookConfig = z.infer<typeof hookConfigSchema>;

// ── PluginConfig (新增 — 用户面向配置, omo 风格) ──

/**
 * PluginConfig = 插件全局配置
 *
 * v1.13 引入 schema, 实际消费接线留 v1.15
 * 设计参考 omo 的 OhMyOpenCodeConfig:
 * - disabled_hooks/tools/mcps 数组
 * - msm_exec 协议层默认选项
 * - 其他可扩展字段
 */
export const pluginConfigSchema = z.object({
  /** 配置 schema 版本 (v1.13 = 1) */
  $schema: z.string().optional(),

  /** 禁用的 hook 列表 (按 hook 名) */
  disabled_hooks: z.array(z.string()).optional(),

  /** 禁用的 tool 列表 (按 tool 名) */
  disabled_tools: z.array(z.string()).optional(),

  /** 禁用的 msm 列表 (按 msm 名) */
  disabled_msms: z.array(z.string()).optional(),

  /** msm_exec 协议层默认 format (v1.14) */
  msm_exec_format: z.enum(['text', 'json']).optional(),

  /** msm_exec 协议层默认 log 路径 (v1.14) */
  msm_exec_log: z.string().optional(),

  /** msm_exec 协议层默认超时 (ms, 默认 30000) */
  msm_exec_timeout_ms: z.number().int().positive().optional(),

  /** 业务 msm 路径黑名单 (安全增强) */
  blocked_msm_paths: z.array(z.string()).optional(),
});

/** 派生 TS 类型 */
export type PluginConfig = z.infer<typeof pluginConfigSchema>;

// ── parseConfig / safeParseConfig ──

/**
 * 校验并返回 PluginConfig (parse 失败时抛 zod.ZodError)
 *
 * 用法:
 * ```ts
 * try {
 *   const config = parseConfig(input);
 *   // config 是已验证的 PluginConfig
 * } catch (err) {
 *   if (err instanceof ZodError) { ... }
 * }
 * ```
 */
export function parseConfig(input: unknown): PluginConfig {
  return pluginConfigSchema.parse(input);
}

/**
 * 不抛错版本 — Result 风格
 *
 * 返回:
 * - { success: true, data: PluginConfig }
 * - { success: false, error: ZodError }
 */
export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: ZodError };

export function safeParseConfig(input: unknown): SafeParseResult<PluginConfig> {
  return pluginConfigSchema.safeParse(input);
}

// ── MechEntry parse 工具 ──

/** 解析 mech-registry.json 顶层 (双 schema 兼容) */
export function parseMechRegistryFile(input: unknown): SafeParseResult<MechRegistryFile> {
  return mechRegistryFileSchema.safeParse(input);
}

/** 解析单条 MechEntry */
export function parseMechEntry(input: unknown): SafeParseResult<MechEntry> {
  return mechEntrySchema.safeParse(input);
}

// ── HookConfig parse 工具 ──

/** 解析 HookConfig (per-hook enable/disable map) */
export function parseHookConfig(input: unknown): SafeParseResult<HookConfig> {
  return hookConfigSchema.safeParse(input);
}
