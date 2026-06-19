/**
 * v1.4 system.transform SKILL.md 注入单测
 *
 * 覆盖：
 * 1. plugin 激活 + skillContent 有值 → 注入到 output.system
 * 2. plugin 未激活 → 跳过（不注入）
 * 3. skillContent 为 null → 跳过
 * 4. 同一 session 多次调用 → dedup（只首次注入）
 * 5. 不同 session → 各自独立注入
 *
 * v0.3 新增：[Serenity Root] 路径注入 + idempotent dedup
 * - root marker 在 SKILL.md 之前注入
 * - skillContent 为 null 时 root marker 仍注入
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setState, resetState, markReady } from '../src/state.js';
import { createCompactingHooks } from '../src/hooks/compacting.js';
import { INACTIVE_STATE, type SerenityState } from '../src/types/index.js';

function makeState(overrides: Partial<SerenityState> = {}): SerenityState {
  return Object.freeze({
    activated: true,
    cwdRoot: '/repo',
    instanceName: 'home-serenity',
    skillPath: '/repo/.opencode/skills/home-serenity/SKILL.md',
    skillContent: '# Mock SKILL.md\n\nThis is the test skill content.',
    ...overrides,
  });
}

describe('v1.4 system.transform SKILL.md injection', () => {
  beforeEach(() => {
    resetState();
  });

  it('plugin 激活 + skillContent 有值 → root marker + SKILL.md 都注入', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform'];
    expect(hook).toBeDefined();

    const output = { system: [] as string[] };
    await hook!({ sessionID: 'sess-1' } as any, output);
    expect(output.system).toHaveLength(2);
    // index 0: root marker
    expect(output.system[0]).toContain('[Serenity Root]');
    expect(output.system[0]).toContain('/repo');
    expect(output.system[0]).toContain('Instance: home-serenity');
    // index 1: SKILL.md
    expect(output.system[1]).toBe('# Mock SKILL.md\n\nThis is the test skill content.');
  });

  it('plugin 未激活 → 跳过（不注入）', async () => {
    setState(INACTIVE_STATE);
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform'];
    expect(hook).toBeDefined();

    const output = { system: [] as string[] };
    await hook!({ sessionID: 'sess-2' } as any, output);
    expect(output.system).toHaveLength(0);
  });

  it('skillContent 为 null（SKILL.md 读失败）→ root marker 仍注入，SKILL.md 跳过', async () => {
    setState(makeState({ skillContent: null }));
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform'];
    expect(hook).toBeDefined();

    const output = { system: [] as string[] };
    await hook!({ sessionID: 'sess-3' } as any, output);
    // root marker 不受 skillContent 影响
    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toContain('[Serenity Root]');
    expect(output.system[0]).toContain('/repo');
  });

  it('同一 session 多次调用 → root marker + SKILL.md 都 dedup（各只注入一次）', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform']!;

    const output = { system: [] as string[] };
    await hook({ sessionID: 'sess-dedup' } as any, output);
    await hook({ sessionID: 'sess-dedup' } as any, output);
    await hook({ sessionID: 'sess-dedup' } as any, output);
    // root marker (1) + SKILL.md (1) = 2，不会堆积
    expect(output.system).toHaveLength(2);
    expect(output.system[0]).toContain('[Serenity Root]');
    expect(output.system[1]).toContain('Mock SKILL.md');
  });

  it('不同 session → 各自独立注入（root marker + SKILL.md 各一份）', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform']!;

    // 真实场景：每个 session 的 system.transform 拿到独立 output
    // 新契约：dedup 在 output.system 上做（不是 sessionID）
    const outputA = { system: [] as string[] };
    const outputB = { system: [] as string[] };
    await hook({ sessionID: 'sess-A' } as any, outputA);
    await hook({ sessionID: 'sess-B' } as any, outputB);
    expect(outputA.system).toHaveLength(2);
    expect(outputB.system).toHaveLength(2);
    expect(outputA.system[0]).toContain('[Serenity Root]');
    expect(outputA.system[1]).toContain('Mock SKILL.md');
    expect(outputB.system[0]).toContain('[Serenity Root]');
    expect(outputB.system[1]).toContain('Mock SKILL.md');
  });

  it('session.compacting 仍注入状态（RR7 兼容保留）', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.session.compacting']!;

    const output = { context: [] as string[] };
    await hook({ sessionID: 'sess-c1' } as any, output);
    expect(output.context.length).toBeGreaterThan(0);
    expect(output.context[0]).toContain('cwdRoot=/repo');
    expect(output.context[0]).toContain('instanceName=home-serenity');
  });
});
