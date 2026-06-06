/**
 * Hook 工厂公共工具（oMo 模式）
 *
 * 设计目标（v0.1-3）：
 * - `isHookEnabled(name, config?)` — 集中开关，禁用某 hook 不影响其他
 * - `safeHook(name, impl, config?)` — try/catch 包装，单 hook 抛错不传播
 *
 * 与 oMo 的差异：粒度更细（每个 hook 独立开关），不引入 5 工厂分层（v0 plugin
 * 规模不到 500 行，过度设计得不偿失）
 */

import type { Hooks } from '@opencode-ai/plugin';

export type HookName = keyof Hooks;

/** hook 集中开关配置（默认全开） */
export type HookConfig = { [K in HookName]?: boolean };

/** 检查 hook 是否启用（默认 true；显式 false 才禁用） */
export function isHookEnabled(name: HookName, config?: HookConfig): boolean {
  if (!config) return true;
  const v = config[name];
  return v !== false;
}

/** hook 实现 + 配置 → 安全包装（禁用返回 undefined；启用则 try/catch 包装抛错） */
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
    } catch {
      // v0.1 策略：所有 hook 抛错都 silent（不 rethrow，不 log）
      // 原因：单 hook 抛错会中断整条 Effect 链（L3 验证），
      //      plugin 应"就像没装一样"（不破坏 opencode 行为）
      // v0.0.1: 不再 console.warn（v0.0.1 release 应静默）
    }
  }) as NonNullable<Hooks[K]>;
}
