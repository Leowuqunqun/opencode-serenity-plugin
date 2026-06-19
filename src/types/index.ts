/**
 * 内部类型定义 — plugin 内部状态 + 内部接口
 *
 * 与外部契约（contract-v0.md）区别：
 * - 外部契约 = plugin 暴露给 opencode runtime + LLM 的接口
 * - 内部类型 = plugin 内部模块间共享的状态 / 函数签名
 */

import type { PluginInput } from '@opencode-ai/plugin';

/** plugin 激活后维护的运行时状态（仅在 plugin 内部使用） */
export type SerenityState = {
  /** 是否激活（RR1+RR6 任一不满足 = false）*/
  activated: boolean;
  /** cwd 根（git root），plugin 一切判断基于此 */
  cwdRoot: string;
  /** CCC 名（从 /.serenity 文件内容读取）*/
  cccName: string;
  /** SKILL.md 绝对路径（.opencode/skills/<cccName>/SKILL.md）*/
  skillPath: string;
  /** SKILL.md 全文（phase2 读取，用于 system.transform 注入到 system prompt）*/
  skillContent: string | null;
  /** Phase 2 初始化是否待进行（SKILL.md 含骨架标记 → true；Agent 完成访谈后外部清） */
  needsPhase2: boolean;
  /** Phase 2 访谈提示词全文（从 scripts/generate-root-skill.prompt.md 读取） */
  phase2Prompt: string | null;
  /** 激活失败原因（仅在 activated=false 时有意义）*/
  failureReason?: string;
};

/** plugin 不激活时的状态工厂 */
export const INACTIVE_STATE: Readonly<SerenityState> = Object.freeze({
  activated: false,
  cwdRoot: '',
  cccName: '',
  skillPath: '',
  skillContent: null,
  needsPhase2: false,
  phase2Prompt: null,
  failureReason: 'plugin not activated',
});

/** PluginInput 的简化别名（plugin 入口签名用） */
export type SerenityPluginInput = PluginInput;

/** 错误恢复策略（每个 hook 内部决定如何处理抛错） */
export type ErrorRecovery = 'silent' | 'log' | 'throw';
