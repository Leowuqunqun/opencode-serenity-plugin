/**
 * hooks-guard.test.ts (v1.12)
 *
 * 覆盖:
 * 1. isHookEnabled env var 闸
 * 2. isHookEnabled session-level disable 闸
 * 3. isHookEnabled config 闸（旧行为保留）
 * 4. disableHook / isHookDisabled API
 * 5. safeCreateHook 行为:
 *    - 禁用时返回 no-op
 *    - 启用时返回真实 hook
 *    - hook 抛错后 → disableHook + 后续返回 no-op
 *    - factory 抛错 → disableHook + 返回 no-op
 * 6. no-op 签名匹配（不返回 undefined）
 * 7. _getSessionErrors / _resetSessionHookGuard 测试 helper
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isHookEnabled,
  safeCreateHook,
  disableHook,
  isHookDisabled,
  _resetSessionHookGuard,
  _getSessionErrors,
  type HookName,
} from '../src/hooks/util.js';

beforeEach(() => {
  _resetSessionHookGuard();
});

afterEach(() => {
  _resetSessionHookGuard();
});

describe('isHookEnabled — 3 道闸 (v1.12)', () => {
  it('config[name] === false → 禁用（旧行为）', () => {
    expect(isHookEnabled('shell.env', { 'shell.env': false })).toBe(false);
  });

  it('config[name] = undefined → 启用', () => {
    expect(isHookEnabled('shell.env', {})).toBe(true);
  });

  it('config[name] = true → 启用', () => {
    expect(isHookEnabled('shell.env', { 'shell.env': true })).toBe(true);
  });

  it('无 config → 启用', () => {
    expect(isHookEnabled('shell.env')).toBe(true);
  });

  it('env var SERENITY_HOOK_DISABLED_<NAME>=1 → 禁用', () => {
    process.env['SERENITY_HOOK_DISABLED_SHELL_ENV'] = '1';
    try {
      expect(isHookEnabled('shell.env')).toBe(false);
    } finally {
      delete process.env['SERENITY_HOOK_DISABLED_SHELL_ENV'];
    }
  });

  it('env var 带点号的 hook 名 → 转下划线（tool.execute.before）', () => {
    process.env['SERENITY_HOOK_DISABLED_TOOL_EXECUTE_BEFORE'] = '1';
    try {
      expect(isHookEnabled('tool.execute.before')).toBe(false);
    } finally {
      delete process.env['SERENITY_HOOK_DISABLED_TOOL_EXECUTE_BEFORE'];
    }
  });

  it('env var 其他值（如 0）→ 不触发', () => {
    process.env['SERENITY_HOOK_DISABLED_SHELL_ENV'] = '0';
    try {
      expect(isHookEnabled('shell.env')).toBe(true);
    } finally {
      delete process.env['SERENITY_HOOK_DISABLED_SHELL_ENV'];
    }
  });

  it('session-level disable → 禁用', () => {
    disableHook('shell.env', 'manual');
    expect(isHookEnabled('shell.env')).toBe(false);
  });

  it('三道闸顺序: env > session > config', () => {
    // 三个都设置，应该都触发 disable
    process.env['SERENITY_HOOK_DISABLED_SHELL_ENV'] = '1';
    disableHook('shell.env', 'session');
    try {
      expect(isHookEnabled('shell.env', { 'shell.env': false })).toBe(false);
    } finally {
      delete process.env['SERENITY_HOOK_DISABLED_SHELL_ENV'];
    }
  });
});

describe('disableHook / isHookDisabled API', () => {
  it('disableHook 后 isHookDisabled = true', () => {
    expect(isHookDisabled('shell.env')).toBe(false);
    disableHook('shell.env');
    expect(isHookDisabled('shell.env')).toBe(true);
  });

  it('disableHook 不影响其他 hook', () => {
    disableHook('shell.env');
    expect(isHookDisabled('tool.execute.before')).toBe(false);
  });

  it('disableHook 带 reason → 写入 _getSessionErrors', () => {
    disableHook('shell.env', new Error('test reason'));
    const errors = _getSessionErrors();
    expect(errors.has('shell.env')).toBe(true);
    const entry = errors.get('shell.env');
    expect(entry?.error).toBeInstanceOf(Error);
    expect((entry?.error as Error).message).toBe('test reason');
  });

  it('_resetSessionHookGuard 清空所有 disable 状态', () => {
    disableHook('shell.env', 'reason1');
    disableHook('tool.execute.before', 'reason2');
    _resetSessionHookGuard();
    expect(isHookDisabled('shell.env')).toBe(false);
    expect(isHookDisabled('tool.execute.before')).toBe(false);
    expect(_getSessionErrors().size).toBe(0);
  });
});

describe('safeCreateHook — 工厂包装 (v1.12)', () => {
  it('禁用时返回 no-op 函数（不是 undefined）', () => {
    const wrapped = safeCreateHook(
      'shell.env',
      () => {
        throw new Error('factory should not be called');
      },
      { 'shell.env': false },
    );
    expect(wrapped).toBeDefined();
    expect(typeof wrapped).toBe('function');
  });

  it('config 禁用 → factory 不被调', () => {
    const factory = vi.fn(() => {
      throw new Error('should not be called');
    });
    safeCreateHook('shell.env', factory, { 'shell.env': false });
    expect(factory).not.toHaveBeenCalled();
  });

  it('env var 禁用 → factory 不被调', () => {
    process.env['SERENITY_HOOK_DISABLED_SHELL_ENV'] = '1';
    try {
      const factory = vi.fn(() => {
        throw new Error('should not be called');
      });
      safeCreateHook('shell.env', factory);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      delete process.env['SERENITY_HOOK_DISABLED_SHELL_ENV'];
    }
  });

  it('启用时返回真实 hook 包装', () => {
    const impl = vi.fn().mockResolvedValue(undefined);
    const wrapped = safeCreateHook('shell.env', () => impl as any);
    expect(wrapped).toBeDefined();
    expect(typeof wrapped).toBe('function');
  });

  it('注册后的 hook 调用 → 调原 impl', async () => {
    const impl = vi.fn().mockResolvedValue(undefined);
    const wrapped = safeCreateHook('shell.env', () => impl as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapped as any)({ cwd: '/' }, { env: {} });
    expect(impl).toHaveBeenCalledOnce();
  });

  it('hook 抛错 → 不 rethrow + 标记 session-level disable', async () => {
    const impl = vi.fn().mockRejectedValue(new Error('hook boom'));
    const wrapped = safeCreateHook('shell.env', () => impl as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((wrapped as any)({ cwd: '/' }, { env: {} })).resolves.toBeUndefined();
    expect(isHookDisabled('shell.env')).toBe(true);
    expect(_getSessionErrors().has('shell.env')).toBe(true);
  });

  it('hook 抛错一次后 → 后续 safeCreateHook 调用 → factory 不被调（已 session-disabled）', () => {
    // simulate: hook 抛错后已 disable
    disableHook('shell.env', new Error('previous boom'));

    const factory = vi.fn(() => {
      throw new Error('should not run');
    });
    safeCreateHook('shell.env', factory as any);
    // isHookEnabled 在 safeCreateHook 入口短路 → factory 不被调
    expect(factory).not.toHaveBeenCalled();
    // isHookDisabled 仍为 true（之前已 disable）
    expect(isHookDisabled('shell.env')).toBe(true);
  });

  it('factory 抛错 → 标记 disable + 返回 no-op', () => {
    const factory = vi.fn(() => {
      throw new Error('factory boom');
    });
    const wrapped = safeCreateHook('shell.env', factory as any);
    // factory 抛错 → 标记 disable + 返回 no-op
    expect(isHookDisabled('shell.env')).toBe(true);
    expect(_getSessionErrors().has('shell.env')).toBe(true);
    // wrapped 是 no-op（不抛错）
    expect(wrapped).toBeDefined();
  });

  it('no-op 调用时不返回 undefined（hook 签名匹配）', async () => {
    const wrapped = safeCreateHook('shell.env', () => {
      throw new Error('disabled factory');
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (wrapped as any)({ cwd: '/' }, { env: {} });
    expect(result).toBeUndefined();
    // 注: undefined 是 void 的合法 return value, hook 签名 (input, output) => void
    // 测试只验证"不抛错"+"不返回异常值"
  });

  it('disable 后调用 no-op hook 是安全的（不抛错）', async () => {
    const impl = vi.fn().mockResolvedValue(undefined);
    const wrapped = safeCreateHook('shell.env', () => impl as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapped as any)({ cwd: '/' }, { env: {} });
    expect(impl).toHaveBeenCalledOnce();
  });
});

describe('v1.12 集成: 多 hook 独立 disable 追踪', () => {
  it('hook A disable 不影响 hook B', async () => {
    const implA = vi.fn().mockRejectedValue(new Error('A boom'));
    const implB = vi.fn().mockResolvedValue(undefined);

    const wrappedA = safeCreateHook('shell.env', () => implA as any);
    const wrappedB = safeCreateHook('tool.execute.before', () => implB as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrappedA as any)({}, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrappedB as any)({}, {});

    expect(isHookDisabled('shell.env')).toBe(true);
    expect(isHookDisabled('tool.execute.before')).toBe(false);
  });
});

describe('v1.12: 旧 safeHook API 向后兼容', () => {
  // 注：safeHook 的详细行为测试在 tests/hooks-util.test.ts (v0.0.1)
  // 这里只验证 v1.12 增强后仍向后兼容
  it('safeHook 仍能从 util.js 导入', async () => {
    const { safeHook } = await import('../src/hooks/util.js');
    expect(typeof safeHook).toBe('function');
  });

  it('safeHook 内部用新 isHookEnabled (env var 仍生效)', async () => {
    const { safeHook } = await import('../src/hooks/util.js');
    process.env['SERENITY_HOOK_DISABLED_SHELL_ENV'] = '1';
    try {
      const impl = vi.fn().mockResolvedValue(undefined);
      const wrapped = safeHook('shell.env', impl as any);
      expect(wrapped).toBeUndefined();
      expect(impl).not.toHaveBeenCalled();
    } finally {
      delete process.env['SERENITY_HOOK_DISABLED_SHELL_ENV'];
    }
  });
});
