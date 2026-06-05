/**
 * Hook 工厂公共工具测试（oMo 模式）
 *
 * 覆盖：isHookEnabled + safeHook
 * - isHookEnabled 默认 true；config[name] === false → false
 * - safeHook 包装 try/catch；抛错不传播
 * - safeHook 禁用时返回 undefined
 */

import { describe, it, expect, vi } from 'vitest';
import { isHookEnabled, safeHook, type HookName } from '../src/hooks/util.js';

describe('isHookEnabled', () => {
  it('returns true by default (no config)', () => {
    expect(isHookEnabled('shell.env')).toBe(true);
  });

  it('returns true when config[name] is undefined', () => {
    expect(isHookEnabled('shell.env', {})).toBe(true);
  });

  it('returns true when config[name] is true', () => {
    expect(isHookEnabled('shell.env', { 'shell.env': true })).toBe(true);
  });

  it('returns false when config[name] is false', () => {
    expect(isHookEnabled('shell.env', { 'shell.env': false })).toBe(false);
  });

  it('handles multiple hook names independently', () => {
    const config: Partial<Record<HookName, boolean>> = {
      'shell.env': false,
      'tool.execute.before': true,
    };
    expect(isHookEnabled('shell.env', config)).toBe(false);
    expect(isHookEnabled('tool.execute.before', config)).toBe(true);
  });
});

describe('safeHook', () => {
  it('returns undefined when disabled', () => {
    const impl = vi.fn();
    const wrapped = safeHook('shell.env', impl, { 'shell.env': false });
    expect(wrapped).toBeUndefined();
    expect(impl).not.toHaveBeenCalled();
  });

  it('returns wrapper function when enabled', () => {
    const impl = vi.fn().mockResolvedValue(undefined);
    const wrapped = safeHook('shell.env', impl);
    expect(wrapped).toBeDefined();
    expect(typeof wrapped).toBe('function');
  });

  it('calls the implementation when invoked', async () => {
    const impl = vi.fn().mockResolvedValue(undefined);
    const wrapped = safeHook('shell.env', impl);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (wrapped as any)({ cwd: '/' }, { env: {} });
    expect(impl).toHaveBeenCalledOnce();
  });

  it('catches errors silently (does not rethrow)', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const impl = vi.fn().mockRejectedValue(new Error('boom'));
    const wrapped = safeHook('shell.env', impl);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((wrapped as any)({ cwd: '/' }, { env: {} })).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[serenity-plugin] hook "shell.env" caught error'),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });
});
