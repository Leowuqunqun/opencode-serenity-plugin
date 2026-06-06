/**
 * v1.4 system.transform SKILL.md 注入单测
 *
 * 覆盖：
 * 1. plugin 激活 + skillContent 有值 → 注入到 output.system
 * 2. plugin 未激活 → 跳过（不注入）
 * 3. skillContent 为 null → 跳过
 * 4. 同一 session 多次调用 → dedup（只首次注入）
 * 5. 不同 session → 各自独立注入
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setState, resetState, markReady } from '../src/state.js';
import { _resetInjectedSessions, createCompactingHooks } from '../src/hooks/compacting.js';
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
    _resetInjectedSessions();
  });

  it('plugin 激活 + skillContent 有值 → 注入', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform'];
    expect(hook).toBeDefined();

    const output = { system: [] as string[] };
    await hook!({ sessionID: 'sess-1' } as any, output);
    expect(output.system).toHaveLength(1);
    expect(output.system[0]).toBe('# Mock SKILL.md\n\nThis is the test skill content.');
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

  it('skillContent 为 null（SKILL.md 读失败）→ 跳过', async () => {
    setState(makeState({ skillContent: null }));
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform'];
    expect(hook).toBeDefined();

    const output = { system: [] as string[] };
    await hook!({ sessionID: 'sess-3' } as any, output);
    expect(output.system).toHaveLength(0);
  });

  it('同一 session 多次调用 → dedup（只首次注入）', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform']!;

    const output = { system: [] as string[] };
    await hook({ sessionID: 'sess-dedup' } as any, output);
    await hook({ sessionID: 'sess-dedup' } as any, output);
    await hook({ sessionID: 'sess-dedup' } as any, output);
    expect(output.system).toHaveLength(1);
  });

  it('不同 session → 各自独立注入', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform']!;

    const output = { system: [] as string[] };
    await hook({ sessionID: 'sess-A' } as any, output);
    await hook({ sessionID: 'sess-B' } as any, output);
    expect(output.system).toHaveLength(2);
    expect(output.system[0]).toContain('Mock SKILL.md');
    expect(output.system[1]).toContain('Mock SKILL.md');
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
