/**
 * tool.definition hook 单测（v0.1 新增：subagent serenity context 注入）
 *
 * 覆盖：
 * 1. task tool → 描述被注入 serenity context
 * 2. 非 task tool → 描述不变
 * 3. plugin 未激活 → 不注入（跳过）
 * 4. 注入 context 包含实例名、根路径、可用工具清单
 * 5. safeCreateHook 降级（disabled → no-op）
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
    skillContent: null,
    ...overrides,
  });
}

describe('tool.definition — serenity context injection', () => {
  beforeEach(() => {
    resetState();
  });

  it('task tool → 描述已注入 serenity context', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['tool.definition'];
    expect(hook).toBeDefined();

    const input = { toolID: 'task' };
    const output = { description: 'Launch a subagent to handle complex tasks.', parameters: undefined };
    await hook!(input as any, output as any);

    expect(output.description).toContain('=== Serenity System Context ===');
    expect(output.description).toContain('Instance: home-serenity');
    expect(output.description).toContain('Root: /repo');
    expect(output.description).toContain('msm_list');
    expect(output.description).toContain('msm_exec');
    expect(output.description).toContain('file_system');
    expect(output.description).toContain('session_tool');
    expect(output.description).toContain('Launch a subagent');
    // 原始描述保留在尾部
    expect(output.description.endsWith('to handle complex tasks.')).toBe(true);
  });

  it('非 task tool（如 bash）→ 描述不变', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['tool.definition'];
    expect(hook).toBeDefined();

    const input = { toolID: 'bash' };
    const output = { description: 'Execute shell commands.', parameters: undefined };
    await hook!(input as any, output as any);

    expect(output.description).toBe('Execute shell commands.');
  });

  it('plugin 未激活 → 跳过（不注入）', async () => {
    setState(INACTIVE_STATE);
    const hooks = createCompactingHooks();
    const hook = hooks['tool.definition'];
    expect(hook).toBeDefined();

    const input = { toolID: 'task' };
    const output = { description: 'Launch a subagent.', parameters: undefined };
    await hook!(input as any, output as any);

    expect(output.description).toBe('Launch a subagent.');
    expect(output.description).not.toContain('Serenity');
  });

  it('safeCreateHook 禁用 → no-op（描述不变）', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks({ 'tool.definition': false });
    const hook = hooks['tool.definition'];
    expect(hook).toBeDefined();

    const input = { toolID: 'task' };
    const output = { description: 'Launch a subagent.', parameters: undefined };
    await hook!(input as any, output as any);

    expect(output.description).toBe('Launch a subagent.');
  });

  it('注入 context 包含 "IMPORTANT" 指令', async () => {
    setState(makeState());
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['tool.definition']!;

    const output = { description: 'test', parameters: undefined };
    await hook({ toolID: 'task' } as any, output as any);

    expect(output.description).toContain('IMPORTANT: Include this serenity context');
  });

  it('不使用 skillContent 不存在时仍注入（仅依赖 instanceName）', async () => {
    setState(makeState({ skillContent: null }));
    markReady();
    const hooks = createCompactingHooks();
    const hook = hooks['tool.definition']!;

    const output = { description: 'test', parameters: undefined };
    await hook({ toolID: 'task' } as any, output as any);

    expect(output.description).toContain('Instance: home-serenity');
    expect(output.description).toContain('Root: /repo');
  });
});
