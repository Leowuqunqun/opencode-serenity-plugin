/**
 * v1.4 + v0.3 system.transform 注入单测
 *
 * 覆盖：
 * 1. plugin 激活 + skillContent 有值 → constraints block + SKILL.md 注入
 * 2. plugin 未激活 → 跳过
 * 3. skillContent 为 null → constraints block 仍注入，SKILL.md 跳过
 * 4. 同一 session 多次调用 → constraints block + SKILL.md 都 dedup
 * 5. 不同 session → 各自独立注入
 * 6. constraints block 包含正确的约束条目
 * 7. session.compacting 仍正常工作
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setState, resetState, markReady } from '../src/state.js';
import { createCompactingHooks } from '../src/hooks/compacting.js';
import { INACTIVE_STATE, type SerenityState } from '../src/types/index.js';

function makeState(overrides: Partial<SerenityState> = {}): SerenityState {
  return Object.freeze({
    activated: true,
    cwdRoot: '/repo',
    cccName: 'home-serenity',
    skillPath: '/repo/.opencode/skills/home-serenity/SKILL.md',
    skillContent: '# Mock SKILL.md\n\nThis is the test skill content.',
    ...overrides,
  });
}

describe('v1.4 system.transform SKILL.md injection', () => {
  beforeEach(() => {
    resetState();
  });

  it('plugin 激活 + skillContent 有值 → constraints block + SKILL.md 都注入', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform'];
    expect(hook).toBeDefined();

    const output = { system: [] as string[] };
    await hook!({ sessionID: 'sess-1' } as any, output);
    expect(output.system).toHaveLength(3);
    // index 0: ACC block
    expect(output.system[0]).toContain('=== Serenity ACC ===');
    expect(output.system[0]).toContain('CCC: home-serenity');
    // index 1: constraints block
    expect(output.system[1]).toContain('=== Serenity Constraints ===');
    expect(output.system[1]).toContain('Root: /repo');
    expect(output.system[1]).toContain('File access');
    expect(output.system[1]).toContain('RR5');
    expect(output.system[1]).toContain('msm_exec');
    expect(output.system[1]).toContain('session');
    // index 2: SKILL.md
    expect(output.system[2]).toBe('# Mock SKILL.md\n\nThis is the test skill content.');
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

  it('skillContent 为 null（SKILL.md 读失败）→ constraints block 仍注入，SKILL.md 跳过', async () => {
    setState(makeState({ skillContent: null }));
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform'];
    expect(hook).toBeDefined();

    const output = { system: [] as string[] };
    await hook!({ sessionID: 'sess-3' } as any, output);
    // constraints block 不受 skillContent 影响（ACC 块也在）
    expect(output.system).toHaveLength(2);
    expect(output.system[0]).toContain('=== Serenity ACC ===');
    expect(output.system[1]).toContain('=== Serenity Constraints ===');
    expect(output.system[1]).toContain('Root: /repo');
  });

  it('同一 session 多次调用 → constraints block + SKILL.md 都 dedup（各只注入一次）', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform']!;

    const output = { system: [] as string[] };
    await hook({ sessionID: 'sess-dedup' } as any, output);
    await hook({ sessionID: 'sess-dedup' } as any, output);
    await hook({ sessionID: 'sess-dedup' } as any, output);
    // ACC block (1) + constraints block (1) + SKILL.md (1) = 3，不会堆积
    expect(output.system).toHaveLength(3);
    expect(output.system[1]).toContain('=== Serenity Constraints ===');
    expect(output.system[2]).toContain('Mock SKILL.md');
  });

  it('不同 session → 各自独立注入（constraints block + SKILL.md 各一份）', async () => {
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
    expect(outputA.system).toHaveLength(3);
    expect(outputB.system).toHaveLength(3);
    expect(outputA.system[1]).toContain('=== Serenity Constraints ===');
    expect(outputA.system[1]).toContain('Root: /repo');
    expect(outputA.system[2]).toContain('Mock SKILL.md');
    expect(outputB.system[1]).toContain('=== Serenity Constraints ===');
    expect(outputB.system[1]).toContain('Root: /repo');
    expect(outputB.system[2]).toContain('Mock SKILL.md');
  });

  it('constraints block 包含全部约束条目', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform']!;

    const output = { system: [] as string[] };
    await hook({ sessionID: 'sess-all' } as any, output);
    const block = output.system[1];  // constraints block is at index 1

    expect(block).toContain('=== Serenity Constraints ===');
    expect(block).toContain('Root: /repo');
    // 5 条约束
    expect(block).toContain('File access');
    expect(block).toContain('RR5');
    expect(block).toContain('msm_exec');
    expect(block).toContain('bash is high-risk fallback; use msm_exec by default — D19');
    expect(block).toContain('inherits ALL constraints');
    expect(block).toContain('no bypass');
    expect(block).toContain('session');
  });

  it('constraints block 不使用旧 [Serenity Root] 格式', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['experimental.chat.system.transform']!;

    const output = { system: [] as string[] };
    await hook({ sessionID: 'sess-oldfmt' } as any, output);
    const block = output.system[1];  // constraints block is at index 1

    // 确保旧格式被完全替换
    expect(block).not.toContain('[Serenity Root]');
    expect(block).not.toContain('Instance: home-serenity');
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
    expect(output.context[0]).toContain('cccName=home-serenity');
  });
});
