/**
 * Compacting / System Transform Hook 工厂
 *
 * 包含：
 * 1. experimental.chat.system.transform — 注入 SKILL.md 全文到 system prompt
 * 2. experimental.session.compacting — 压缩时注入"serenity 关键状态" context
 *
 * 设计：
 * - system.transform 唯一职责：把 state.skillContent 全文 push 到 system prompt
 * - 同一 session 内 system.transform 可能被多次触发（每次重建 system prompt），
 *   通过检查 output.system 是否已包含 skillContent 实现 idempotent dedup（无状态）
 * - compacting 保留：避免 serenity 关键状态被压缩丢失
 */

import type { Hooks } from '@opencode-ai/plugin';
import { getState, ensureReady } from '../state.js';
import { safeCreateHook, type HookConfig } from './util.js';

const systemTransformImpl: NonNullable<Hooks['experimental.chat.system.transform']> = async (
  _input,
  output,
) => {
  try {
    await ensureReady();
  } catch {
    return;
  }

  const state = getState();
  if (!state.skillContent) return;  // SKILL.md 读失败或缺失 → 跳过

  // idempotent dedup：检查 output.system 是否已包含 skillContent
  if (output.system.includes(state.skillContent)) return;

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

/**
 * tool.definition — 为 task tool 注入 serenity 精简上下文，
 * 让 LLM 在创建 subagent 时自动把 context 传入 prompt 参数。
 *
 * 只劫持 toolID === 'task'，其他 tool 透传。
 */
const toolDefinitionImpl: NonNullable<Hooks['tool.definition']> = async (
  input,
  output,
) => {
  // 只处理 task tool（subagent 创建）
  if (input.toolID !== 'task') return;

  try {
    await ensureReady();
  } catch {
    return;
  }

  const state = getState();
  if (!state.activated || !state.instanceName) return;

  const context = [
    `=== Serenity System Context ===`,
    `Instance: ${state.instanceName}`,
    `Root: ${state.cwdRoot}`,
    ``,
    `Available serenity tools for subagents:`,
    `  - msm_list — discover registered MSM tools with descriptions`,
    `  - msm_exec — execute an MSM by name with string array args`,
    `  - file_system — safe file operations within serenity root`,
    `  - session_tool — session lifecycle management`,
    ``,
    `IMPORTANT: Include this serenity context in the 'prompt'`,
    `parameter so the subagent can use serenity tools.`,
    `=== End Serenity Context ===`,
  ].join('\n');

  output.description = context + '\n\n' + output.description;
};

/** 工厂：返回 compacting / system transform / tool definition 相关的 hooks 集合
 *
 * v1.12: 改用 safeCreateHook（factory pattern）
 * - safeHook（旧）：禁用时返回 undefined（hook 不注册）
 * - safeCreateHook（新）：禁用时返回 no-op（hook 注册但不做事）— host 期望 hook 存在
 */
export function createCompactingHooks(config?: HookConfig): Partial<Hooks> {
  const hooks: Partial<Hooks> = {};

  hooks['experimental.chat.system.transform'] = safeCreateHook(
    'experimental.chat.system.transform',
    () => systemTransformImpl,
    config,
  );

  hooks['experimental.session.compacting'] = safeCreateHook(
    'experimental.session.compacting',
    () => sessionCompactingImpl,
    config,
  );

  hooks['tool.definition'] = safeCreateHook(
    'tool.definition',
    () => toolDefinitionImpl,
    config,
  );

  return hooks;
}
