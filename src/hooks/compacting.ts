/**
 * Compacting / System Transform / Tool Definition Hook 工厂
 *
 * 包含：
 * 1. experimental.chat.system.transform — 注入操作约束摘要 + SKILL.md 全文到 system prompt
 * 2. experimental.session.compacting — 压缩时注入"serenity 关键状态" context
 * 3. tool.definition — 为 subagent task tool 注入约束警告 + 可用工具
 *
 * design：
 * - system.transform（v0.3 扩展）：
 *   1) 注入 === Serenity ACC === 认知块（仅 CCC 激活时）
 *   2) 注入 === Serenity Constraints === 约束摘要块（idempotent dedup）
 *   3) 注入 state.skillContent 全文（idempotent dedup）
 * - 同一 session 内 system.transform 可能被多次触发（每次重建 system prompt），
 *   通过检查 output.system 是否已包含目标内容实现 idempotent dedup（无状态）
 * - compacting 保留：避免 serenity 关键状态被压缩丢失
 */

import type { Hooks } from '@opencode-ai/plugin';
import { getState, ensureReady, clearPhase2Flag } from '../state.js';
import { safeCreateHook, type HookConfig } from './util.js';
import pkg from '../../package.json' with { type: 'json' };

const VERSION: string = pkg.version;

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

  // ── 注入 ACC 认知（告诉 Agent 它在 ACC/CCC 体系中运行）──
  // 仅在 CCC 已激活时注入
  const accMarker = '=== Serenity ACC ===';
  if (state.cccName && !output.system.some((s) => typeof s === 'string' && s.includes(accMarker))) {
    const accBlock = [
      '',
      `=== Serenity ACC ===`,
      `ACC: opencode-serenity-plugin v${VERSION}`,
      `CCC: ${state.cccName}  Root: ${state.cwdRoot}`,
      '',
      `This agent is running inside a Cognitive Container (CCC) —`,
      `a workspace managed by the ACC (Abstract Cognitive Container)`,
      `plugin. The ACC provides built-in tools (msm_list, msm_exec,`,
      `msm_admin, cc-fs, session, cc-ck, eap, neat), path isolation (P3),`,
      `and session tracking. Additional MSMs may be registered in this CCC.`,
      '',
    ].join('\n');
    output.system.push(accBlock);
  }

  // 注入操作约束摘要（帮助 Agent 理解运行上下文）
  // idempotent：检查 output.system 中是否已包含标记头
  const marker = '=== Serenity Constraints ===';
  if (!output.system.some(s => typeof s === 'string' && s.includes(marker))) {
    const block = [
      '',
      '=== Serenity Constraints ===',
      `Root: ${state.cwdRoot}`,
      '  • File access → read/edit/write/grep/glob limited to root (RR5)',
      '  • Shell → use msm_exec (bash is high-risk fallback; use msm_exec by default — D19)',
      '  • Subagent → inherits ALL constraints (no bypass)',
      '  • Session-first: propose existing or new session; wait for user to say "使用" or "use" to confirm before starting work',
      '',
    ].join('\n');
    output.system.push(block);
  }

  // 注入 SKILL.md 全文
  if (!state.skillContent) return;  // SKILL.md 读失败或缺失 → 跳过
  if (output.system.includes(state.skillContent)) return;
  output.system.push(state.skillContent);
};

/**
 * messages.transform — Phase 2 强制访谈（DCP 同款模式）。
 *
 * 当 activation 检测到 SKILL.md 为骨架模板（needsPhase2=true），
 * 将最后一条用户消息替换为 Phase 2 访谈提示词，实现"无论用户发了什么都进入初始化"。
 *
 * 替换后立即清除 needsPhase2，确保后续消息不被重复注入。
 */
const messagesTransformImpl: NonNullable<Hooks['experimental.chat.messages.transform']> = async (
  _input,
  output,
) => {
  try {
    await ensureReady();
  } catch {
    return;
  }

  const state = getState();
  if (!state.needsPhase2 || !state.phase2Prompt) return;

  // 从后往前找最后一个真实用户消息（跳过 synthetic / ignored / non-user）
  const messages = output.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.info.role !== 'user') continue;

    for (const part of msg.parts) {
      if (part.type !== 'text') continue;
      if (part.ignored || (part as any).synthetic) continue;

      // 替换消息文本为 Phase 2 访谈提示词
      part.text = state.phase2Prompt;
      clearPhase2Flag();
      return;
    }
  }
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
    `[serenity-state] cwdRoot=${state.cwdRoot}; cccName=${state.cccName}; skillPath=${state.skillPath}`,
  );
};

/**
 * tool.definition — 为 task tool（subagent 创建）注入 serenity 上下文。
 *
 * 核心信息：subagent 继承全部 serenity 约束。
 * 目的：防止 primary agent 以为“派 subagent 能绕过限制”。
 *
 * 包括：
 *   1. 实例信息（instance name + root path）
 *   2. 明确声明 subagent 受相同限制（路径守卫、bash 开关等）
 *   3. subagent 可用的工具清单
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
  if (!state.activated || !state.cccName) return;

  const context = [
    `=== Serenity System Context ===`,
    `CCC: ${state.cccName}`,
    `Root: ${state.cwdRoot}`,
    ``,
    `WARNING: Subagents inherit ALL serenity constraints.`,
    `Spawning a subagent does NOT bypass serenity restrictions.`,
    ``,
    `Constraints that also apply to subagents:`,
    `  - File access (read/edit/write/grep/glob) is LIMITED to the serenity root.`,
    `    Paths outside ${state.cwdRoot} will be REJECTED.`,
    `  - bash is high-risk fallback; use msm_exec by default (D19).`,
    `  - For shell commands, use msm_exec with an appropriate MSM.`,
    ``,
    `If the primary agent is blocked by a constraint, the subagent will be blocked too.`,
    `Do NOT delegate restricted operations to a subagent as a workaround.`,
    ``,
    `Available serenity tools (subagent can use these):`,
    `  - msm_list  — discover registered MSM tools with descriptions`,
    `  - msm_exec  — execute an MSM by name with string array args`,
    `  - cc-fs — safe file operations within serenity root`,
    `  - eap  — cognitive quality framework (EAP SKILL.md content)`,
    `  - neat — design collaboration protocol (Neat SKILL.md content)`,
    `  - session — session lifecycle management`,
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

  hooks['experimental.chat.messages.transform'] = safeCreateHook(
    'experimental.chat.messages.transform',
    () => messagesTransformImpl,
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
