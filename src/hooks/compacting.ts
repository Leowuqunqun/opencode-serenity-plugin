/**
 * Compacting / System Transform Hook 工厂
 *
 * 包含：
 * 1. experimental.chat.system.transform — 注入 SKILL.md 全文到 system prompt
 * 2. experimental.session.compacting — 压缩时注入"serenity 关键状态" context
 *
 * 设计（v1.4 简化）：
 * - system.transform 唯一职责：把 state.skillContent 全文 push 到 system prompt
 * - RR3 / RR7 杂项提示**移除**（user m0498："只加载 xx-serenity 这个 skill"）
 *   - RR3 安全靠"同名 bash tool 覆盖抛错"双层防护，不靠 prompt
 *   - RR7 走 plugin 协议工具自描述（msm_register 等）
 * - 同一 session 内 system.transform 可能被多次触发（每次重建 system prompt），
 *   但 plugin 只在用户消息进来时 push 一次；用 Set<sessionID> dedup
 * - compacting 保留：避免 serenity 关键状态被压缩丢失
 */

import type { Hooks } from '@opencode-ai/plugin';
import { getState, ensureReady } from '../state.js';
import { isHookEnabled, safeHook, type HookConfig } from './util.js';

/** session 级 dedup：避免 system.transform 重复注入 */
const _injectedSessions = new Set<string>();

const systemTransformImpl: NonNullable<Hooks['experimental.chat.system.transform']> = async (
  input,
  output,
) => {
  try {
    await ensureReady();
  } catch {
    return;
  }

  const state = getState();
  if (!state.skillContent) return;  // SKILL.md 读失败或缺失 → 跳过

  // dedup：每个 session 只注入一次
  const sessionID = input.sessionID ?? '__no_session__';
  if (_injectedSessions.has(sessionID)) return;
  _injectedSessions.add(sessionID);

  output.system.push(state.skillContent);
};

const sessionCompactingImpl: NonNullable<Hooks['experimental.session.compacting']> = async (
  _input,
  output,
) => {
  try {
    await ensureReady();
  } catch {
    return;
  }

  const state = getState();
  output.context.push(
    `[serenity-state] cwdRoot=${state.cwdRoot}; instanceName=${state.instanceName}; skillPath=${state.skillPath}`,
  );
};

/** 测试用：清空 dedup Set */
export function _resetInjectedSessions(): void {
  _injectedSessions.clear();
}

/** 工厂：返回 compacting / system transform 相关的 hooks 集合 */
export function createCompactingHooks(config?: HookConfig): Partial<Hooks> {
  const hooks: Partial<Hooks> = {};

  if (isHookEnabled('experimental.chat.system.transform', config)) {
    const wrapped = safeHook('experimental.chat.system.transform', systemTransformImpl, config);
    if (wrapped) hooks['experimental.chat.system.transform'] = wrapped;
  }

  if (isHookEnabled('experimental.session.compacting', config)) {
    const wrapped = safeHook('experimental.session.compacting', sessionCompactingImpl, config);
    if (wrapped) hooks['experimental.session.compacting'] = wrapped;
  }

  return hooks;
}
