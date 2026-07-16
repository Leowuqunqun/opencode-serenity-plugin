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
 *   2) 注入 === Serenity CCE === CCE 理论约束块（仅 CCC 激活时）
 *   3) 注入 === Serenity Constraints === 约束摘要块（idempotent dedup）
 *   4) 注入 state.skillContent 全文（idempotent dedup）
 * - 同一 session 内 system.transform 可能被多次触发（每次重建 system prompt），
 *   通过检查 output.system 是否已包含目标内容实现 idempotent dedup（无状态）
 * - compacting 保留：避免 serenity 关键状态被压缩丢失
 */

import type { Hooks } from '@opencode-ai/plugin';
import { getState, ensureReady, clearPhase2Flag } from '../state.js';
import { safeCreateHook, type HookConfig } from './util.js';
import { getActiveSession, setActiveSession, getLastActiveSession } from '../session/active-state.js';
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
      `You are running inside a Concrete Cognitive Container (CCC) —`,
      `the runtime instance of an Abstract Cognitive Container (ACC).`,
      `The ACC (this plugin) provides the following built-in tools:`,
      '',
      `  msm_list  — list all registered MSM tools (name | skill | category | description)`,
      `  msm_exec  — safely execute a registered MSM by name with string array args`,
      `  msm_admin — register/deregister MSMs, run quality checks, view dev guide`,
      `  cc-fs     — file operations strictly within Root (root/resolve/list/mkdir/rm/mv/cp/touch/tree/append)`,
      `  session   — session lifecycle (list/show/create/use/close/health/qa/archive/summary)`,
      `  cc-ck     — validate CCC three principles (P1 rooted / P2 git-managed / P3 binary permissions)`,
      `  eap       — return the full EAP cognitive quality framework`,
      `  neat      — return the full Neat design collaboration protocol`,
      '',
      `Additional MSMs registered by this CCC are available — call msm_list to discover them.`,
      '',
    ].join('\n');
    output.system.push(accBlock);
  }

  // ── 注入 CCE 认知连续性工程（告诉 Agent 它受 CCE 理论约束）──
  const cceMarker = '=== Serenity CCE ===';
  if (state.cccName && !output.system.some((s) => typeof s === 'string' && s.includes(cceMarker))) {
    const cceBlock = [
      '',
      '=== Serenity CCE ===',
      '',
      'You are operating inside a Cognitive Container governed by Cognitive Continuity',
      'Engineering (CCE) — the engineering discipline of maintaining identity, accessibility,',
      'and evolution of a cognitive entity through time under bounded resources.',
      '',
      'CCE does not optimize cognition. It preserves the conditions under which cognition',
      'can continue.',
      '',
      'FIVE BEHAVIORAL CONSTRAINTS (engineering requirements, not suggestions):',
      '',
      '1. Continuity — every interaction modifies the container\'s future state. Before',
      '   acting, consult what came before — prior decisions, abstractions, constraints.',
      '   You are part of a trajectory, not a fresh start.',
      '',
      '2. Bounded Space — the container has boundaries. Respect them. Do not assume',
      '   knowledge that has not been accumulated within this container.',
      '',
      '3. Entropy is Intrinsic — every cognitive system accumulates entropy (duplication,',
      '   obsolescence, conflict, fragmentation, drift). When you produce output, consider',
      '   whether you are adding entropy or reducing it. Favor entropy-reducing actions —',
      '   organizing, deduplicating, cross-referencing, abstracting.',
      '',
      '4. Reconstruction > Preservation — stored artifacts have value only insofar as',
      '   they enable future cognition to recover the reasoning that produced them. When',
      '   recording decisions, ensure reconstruction is possible — not just conclusions,',
      '   but rationale, alternatives considered, and constraints that shaped the choice.',
      '',
      '5. Multi-Agent Cognition — the container is shared. Continuity belongs to the',
      '   container, not to any individual agent. Write for future agents who will enter',
      '   after you leave. They should be able to pick up where you left off.',
      '',
      'OPERATIONAL ENTROPY: The container\'s health metric is operational cognitive entropy',
      '(H_op) — the excess cognitive cost for agents to complete tasks due to disorder.',
      'The container is healthy when H_op ≤ H_critical (agents can still function). The',
      'continuity condition: organization must at minimum match accumulation (ΔH_org ≥ ΔH_in).',
      'Your actions affect H_op — unorganized output increases it, organization decreases it.',
      '',
      'CCE AND EAP: EAP governs artifact quality (how explicit to be). CCE governs temporal',
      'coherence (how to maintain consistency over time). When structuring a document, apply',
      'EAP (E↑ R↓ S↑). When maintaining cross-session coherence, apply CCE.',
      '',
      'THIS IS PERSISTENCE ENGINEERING: The goal is not to become greater. The goal is to',
      'remain coherent. CCE has no terminal KPI — continuity is maintained while the entity',
      'exists, not optimized toward an endpoint.',
      '',
    ].join('\n');
    output.system.push(cceBlock);
  }

  // 注入操作约束摘要（帮助 Agent 理解运行上下文）
  // idempotent：检查 output.system 中是否已包含标记头
  const marker = '=== Serenity Constraints ===';
  if (!output.system.some(s => typeof s === 'string' && s.includes(marker))) {
    const block = [
      '',
      '=== Serenity Constraints ===',
      `Root: ${state.cwdRoot}`,
      '  • File access — read/edit/write/grep/glob are confined to Root; paths outside Root are rejected (RR5)',
      '  • Shell — use msm_exec by default. Note: bash may be disabled by the user (bash = high-risk; only available when explicitly enabled — D19)',
      '  • Subagent — copies ALL parent constraints: file boundary, shell rules, session rules (no bypass)',
      '  • Session-first — before starting multi-step work, propose an existing or new AGENT_SESSIONS entry; wait for user "use" or "使用" to confirm',
      '',
    ].join('\n');
    output.system.push(block);
  }

  // 注入 SKILL.md 全文
  if (!state.skillContent) return;  // SKILL.md 读失败或缺失 → 跳过
  if (output.system.includes(state.skillContent)) return;
  output.system.push(state.skillContent);

  // 注入当前活跃会话（idempotent）
  const sessionMarker = '=== Serenity Session ===';
  if (!output.system.some(s => typeof s === 'string' && s.includes(sessionMarker))) {
    if (_input.sessionID) {
      const active = getActiveSession(_input.sessionID);
      if (active) {
        output.system.push(
          `\n=== Serenity Session ===\n` +
          `Active session: ${active.sessionId} — ${active.dirName}\n` +
          `SESSION.md path: ${active.mdPath}\n` +
          `\n` +
          `Rules:\n` +
          `  • Record all progress into this SESSION.md\n` +
          `  • Update the "进度记录" section after advancing work\n` +
          `  • Reference this session in all subsequent messages\n` +
          `\n` +
          `IMPORTANT: Read SESSION.md now. Parse the "剩余工作" / "进度记录" /\n` +
          `"变更日志" sections and call todowrite to synchronize the built-in todo\n` +
          `list. Keep todos in sync with SESSION.md as work progresses.\n` +
          `\n` +
          `CRITICAL: When calling todowrite, the first item in the todos array MUST\n` +
          `always be:\n` +
          `  { content: "SESSION: ${active.sessionId} — ${active.dirName.replace(/^\d{4}-\d{2}-\d{2}--/, '')}",\n` +
          `    status: "completed", priority: "low" }\n` +
          `This preserves the session context across todo updates.\n` +
          `Do NOT remove or reorder this item — keep it at position 0.\n`,
        );
      }
    }
  }
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
  const messages = output.messages ?? [];

  // ── 活跃会话自动恢复 ──
  // 当 Map 为空（进程重启/恢复会话）时，从历史消息中寻找 [SESSION CONTEXT] 模式恢复状态
  const ocSessionId = (_input as any).sessionID as string | undefined;
  if (ocSessionId) {
    const existing = getActiveSession(ocSessionId);
    if (!existing) {
      for (const msg of messages) {
        for (const part of (msg as any).parts ?? []) {
          if (part.type === 'toolResult') {
            const text = typeof part.output === 'string' ? part.output : '';
            if (text.includes('[SESSION CONTEXT] Activated:')) {
              const lines = text.split('\n');
              let dirName = '';
              let mdPath = '';
              for (const line of lines) {
                if (line.includes('[SESSION CONTEXT] Activated:')) {
                  dirName = line.split('Activated:')[1]?.trim() ?? '';
                }
                if (line.startsWith('SESSION.md path:')) {
                  mdPath = line.split('SESSION.md path:')[1]?.trim() ?? '';
                }
              }
              if (dirName) {
                const idMatch = dirName.match(/S(\d{3,})/);
                const sessionId = idMatch ? `S${idMatch[1]}` : dirName;
                setActiveSession(ocSessionId, { sessionId, dirName, mdPath });
              }
              break;
            }
          }
        }
      }
    }
  }

  // ── Phase 2 强制访谈 ──
  if (!state.needsPhase2 || !state.phase2Prompt) return;
  // 从后往前找最后一个真实用户消息（跳过 synthetic / ignored / non-user）
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
  const serenityCtx = `[serenity-state] cwdRoot=${state.cwdRoot}; cccName=${state.cccName}; skillPath=${state.skillPath}`;
  output.context.push(serenityCtx);

  // 注入当前 OpenCode 会话的活跃 session 上下文（in-memory，不落盘）
  const active = getActiveSession(_input.sessionID);
  if (active) {
    const shortName = active.dirName.replace(/^\d{4}-\d{2}-\d{2}--/, '');
    output.context.push(
      `[active-session] id=${active.sessionId}; dir=${active.dirName}; path=${active.mdPath}`,
    );
    output.context.push(
      `[active-session-todo] todowrite first item MUST be: SESSION: ${active.sessionId} — ${shortName} (completed, low); keep at position 0 permanently`,
    );
  }
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

  // 获取最近活跃会话（tool.definition 无 sessionID 参数，所以用全局指针）
  const activeSession = getLastActiveSession();

  const sessionLines = activeSession
    ? [
        ``,
        `Active session: ${activeSession.sessionId} — ${activeSession.dirName}`,
        `SESSION.md path: ${activeSession.mdPath}`,
      ]
    : [];

  const contextLines = [
    `=== Serenity System Context ===`,
    `CCC: ${state.cccName}`,
    `Root: ${state.cwdRoot}`,
    ``,
    `Subagent constraints (identical to parent agent):`,
    `  • File tools (read/edit/write/grep/glob) confined to Root; outside access rejected`,
    `  • Shell commands via msm_exec + MSM name. bash may be disabled by user — do not assume bash is available`,
    `  • All constraints inherited unconditionally — no delegation bypass`,
    ...sessionLines,
    ``,
    `Available serenity tools (subagent can use these):`,
    `Call msm_list to discover CCC-registered MSMs. ACC built-in tools always available:`,
    `  msm_list  — list all registered MSMs: name, skill, category, description`,
    `  msm_exec  — execute an MSM by name, args as string array`,
    `  cc-fs     — file ops within root: root/resolve/list/exists/mkdir/rm/mv/cp/touch/tree/append`,
    `  eap       — full EAP cognitive quality framework (E/R/S theory + practice)`,
    `  neat      — full Neat design collaboration protocol`,
    `  session   — session lifecycle: list/show/create/use/close/health/qa/archive/summary`,
    ``,
    `CCE Behavioral Constraints (inherited):`,
    `  1. Continuity — you are part of a cognitive trajectory; consult prior decisions`,
    `  2. Bounded Space — respect container boundaries; do not assume external knowledge`,
    `  3. Entropy — favor entropy-reducing actions (organize, deduplicate, abstract)`,
    `  4. Reconstruction — record rationale, not just conclusions; enable future recovery`,
    `  5. Multi-Agent — write for future agents who enter after you leave`,
    ``,
    `IMPORTANT: Append this entire block to the 'prompt' parameter of the task tool.`,
    `The subagent must know: 1) Root boundary, 2) available tools, 3) bash is unavailable, 4) CCE constraints, 5) active session.`,
    `=== End Serenity Context ===`,
  ];

  const context = contextLines.join('\n');

  // 追加 SKILL.md 全文（subagent 继承 CCC 认知上下文）
  const skillPart = state.skillContent
    ? `\n\n=== Serenity Skill ===\n${state.skillContent}`
    : '';

  output.description = context + skillPart + '\n\n' + output.description;
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
