/**
 * Hook 工厂公共工具（oMo 模式 v1.12 增强）
 *
 * v1.12 新增 3 项能力（D25 决策 — 仿 omo safeHook 模式 + 失败自动 disable）：
 * 1. `isHookEnabled(name, config?)` — 集中开关
 *    - 显式 config[name] === false → 禁用
 *    - 环境变量 `SERENITY_HOOK_DISABLED_<NAME>=1` → 禁用
 *    - module-level disable（plugin process lifetime）→ 禁用
 * 2. `disableHook(name, reason?)` / `isHookDisabled(name)` — 手动 / 自动禁用
 * 3. `safeCreateHook(name, factory, config?)` — 工厂包装（v1.12 推荐 API）
 *    - isHookEnabled === false → 返回 no-op 函数（hook 签名匹配）
 *    - factory 抛错 → 标记 disabled + 返回 no-op（**避免 retry storm**）
 *    - 注册后 hook 抛错 → 标记 disabled + 不 rethrow（**不传播 = 整 plugin 不挂**）
 *    - 错误信息用 log.debug 记录 + module-level _sessionErrors Map 保留
 *
 * state lifetime: plugin process lifetime（不是 chat session）
 * - 一个 opencode 进程 = 一个 plugin 进程 = 一组 disable 状态
 * - 测试用 `_resetSessionHookGuard()` 显式清空（vitest beforeEach 已挂上）
 *
 * 向后兼容（v0.0.1 → v1.12）：
 * - 旧 `safeHook(name, impl, config?)` 仍工作；内部已升级走新 isHookEnabled
 * - 旧 `isHookEnabled(name, config?)` 签名不变，行为增强（环境变量 + module-level disable）
 *
 * 与 omo 的差异（v1.12 比 omo 更细）：
 * - 粒度更细：每个 hook 独立 disable
 * - 多层 disable：env var / process / config 三道闸
 * - module-level 自动 disable（hook 抛错一次后本次 plugin process 不再试）
 *
 * v1.12 决策：v0.1-3 决策依然有效（"plugin 应静默"），所以 hook 抛错**不 rethrow**
 * 但**不静默丢弃** — 错误信息存到 _sessionErrors Map，调试时可查
 *
 * v1.18 收口：HookName / HookConfig / HOOK_NAMES 全部从 config-schema.ts 导入
 * （单一真相源，zod record 严格校验 key ∈ HOOK_NAMES）。
 */

import type { Hooks } from '@opencode-ai/plugin';
import { log } from '../util/log.js';
import {
  HOOK_NAMES,
  type HookName,
  type HookConfig,
} from '../config-schema.js';

// 重新导出供现有 import 路径继续工作（hooks/util.js 是公开 API）
export { HOOK_NAMES };
export type { HookName, HookConfig };

/** module-level disable + 错误追踪状态（plugin process lifetime；测试用 reset API） */
const _sessionDisabled = new Set<HookName>();
const _sessionErrors = new Map<HookName, { error: unknown; ts: Date }>();

/**
 * 把 hook name 转成 env var key
 *
 * 例:
 *   'shell.env' → 'SERENITY_HOOK_DISABLED_SHELL_ENV'
 *   'tool.execute.before' → 'SERENITY_HOOK_DISABLED_TOOL_EXECUTE_BEFORE'
 *   'experimental.chat.system.transform' → 'SERENITY_HOOK_DISABLED_EXPERIMENTAL_CHAT_SYSTEM_TRANSFORM'
 */
function envVarKeyForHook(name: HookName): string {
  const normalized = name
    .replace(/\./g, '_')
    .replace(/-/g, '_')
    .toUpperCase();
  return `SERENITY_HOOK_DISABLED_${normalized}`;
}

/** 检查 hook 是否启用（默认 true；任一闸 false 则禁用） */
export function isHookEnabled(name: HookName, config?: HookConfig): boolean {
  // 1. 环境变量闸
  if (process.env[envVarKeyForHook(name)] === '1') return false;

  // 2. session-level disable 闸（v1.12：throw 一次后自动 disable）
  if (_sessionDisabled.has(name)) return false;

  // 3. config 闸
  if (config && config[name] === false) return false;

  return true;
}

/** 显式禁用一个 hook（手动或自动触发） */
export function disableHook(name: HookName, reason?: unknown): void {
  _sessionDisabled.add(name);
  if (reason !== undefined) {
    _sessionErrors.set(name, { error: reason, ts: new Date() });
  }
  log.debug('hooks-guard', 'hook disabled', { name, reason: String(reason) });
}

/** 检查 hook 是否已被 session-level 禁用 */
export function isHookDisabled(name: HookName): boolean {
  return _sessionDisabled.has(name);
}

/** 拿 session-level 错误 Map（调试用） */
export function _getSessionErrors(): ReadonlyMap<HookName, { error: unknown; ts: Date }> {
  return _sessionErrors;
}

/** 测试用：清空 session-level disable 状态 */
export function _resetSessionHookGuard(): void {
  _sessionDisabled.clear();
  _sessionErrors.clear();
}

/**
 * no-op hook（v1.12：safeCreateHook 禁用时返回的 stub）
 *
 * 签名匹配：所有 opencode hook 接受 (input, output) → Promise<void> | void
 * no-op 不做事，类型断言成对应 hook
 */
function noOpHook<K extends HookName>(_name: K): NonNullable<Hooks[K]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async (..._args: unknown[]) => {
    // no-op: 不 rethrow 不 log（v0.0.1 release 静默原则）
    // 调试时: log.debug('hooks-guard', 'no-op hook called', { name: _name });
  }) as NonNullable<Hooks[K]>;
}

/**
 * safeCreateHook（v1.12 推荐 API）
 *
 * 包装 hook factory：
 * 1. isHookEnabled === false → 返回 no-op（hook 签名匹配，host 调用但不做事）
 * 2. factory() 抛错 → log.debug + disableHook + 返回 no-op
 * 3. 注册后 hook 抛错 → log.debug + disableHook + 不 rethrow
 *
 * @param name    hook 名（用于 env var / session disable 追踪）
 * @param factory 工厂函数（v0 模式：返回 hook impl；这里就是返回 impl 本身）
 * @param config  per-hook 配置（可选）
 */
export function safeCreateHook<K extends HookName>(
  name: K,
  factory: () => NonNullable<Hooks[K]>,
  config?: HookConfig,
): NonNullable<Hooks[K]> {
  // 闸 1: 启用？
  if (!isHookEnabled(name, config)) {
    return noOpHook(name);
  }

  // 闸 2: factory 抛错？
  let hookImpl: NonNullable<Hooks[K]>;
  try {
    hookImpl = factory();
  } catch (err) {
    disableHook(name, err);
    return noOpHook(name);
  }

  // 闸 3: 注册后 hook 抛错 → disable + 不 rethrow
  return (async (input: unknown, output: unknown) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (hookImpl as any)(input, output);
    } catch (err) {
      disableHook(name, err);
      // v0.0.1 release 静默：不 rethrow，不 console 输出
    }
  }) as NonNullable<Hooks[K]>;
}

/**
 * safeHook（v0.0.1 旧 API，向后兼容）
 *
 * 行为：
 * - isHookEnabled === false → 返回 undefined（host 不注册 hook，走默认）
 * - 注册后 hook 抛错 → v1.12: disableHook + 不 rethrow
 *
 * 与 safeCreateHook 区别：
 * - safeCreateHook 返回 no-op（hook 已注册但不做事）
 * - safeHook 返回 undefined（hook 未注册）
 *
 * 选择建议：
 * - 旧代码（v0.1-3 起的 hook 工厂）继续用 safeHook，行为兼容
 * - 新代码推荐 safeCreateHook，hook 仍注册（host 期望所有 hook 都存在）
 */
export function safeHook<K extends HookName>(
  name: K,
  impl: NonNullable<Hooks[K]>,
  config?: HookConfig,
): NonNullable<Hooks[K]> | undefined {
  if (!isHookEnabled(name, config)) return undefined;

  return (async (input: unknown, output: unknown) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (impl as any)(input, output);
    } catch (err) {
      // v0.0.1 release 静默：不 rethrow，不 console 输出
      // v1.12: mark disabled for rest of session
      disableHook(name, err);
    }
  }) as NonNullable<Hooks[K]>;
}
