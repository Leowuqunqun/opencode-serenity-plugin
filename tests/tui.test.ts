/**
 * TUI plugin 入口单测 — smoke test
 *
 * v1.9：default export 改为 { id, tui } 对象形式（R-β fix）
 * 测试点：
 * 1. 形状：default 是对象，含 id（string）和 tui（function）
 * 2. 行为：调用 tui(api) 应当不抛错，且注册了 app_bottom slot + 调用了 toast
 */

import { describe, it, expect } from 'vitest';
import tui from '../src/tui.js';

describe('TUI plugin entry', () => {
  it('tui default export 是 { id, tui } 对象', () => {
    expect(typeof tui).toBe('object');
    expect(tui).not.toBeNull();
    expect(typeof (tui as { tui?: unknown }).tui).toBe('function');
    expect(typeof (tui as { id?: unknown }).id).toBe('string');
  });

  it('tui.tui 接受 fake api 并注册 slot + toast', async () => {
    const registeredSlots: Array<{ order: number; names: string[] }> = [];
    const toastCalls: unknown[] = [];

    const fakeApi = {
      slots: {
        register(plugin: { order: number; slots: Record<string, unknown> }) {
          registeredSlots.push({ order: plugin.order, names: Object.keys(plugin.slots) });
          return () => {};
        },
      },
      ui: {
        toast(input: unknown) {
          toastCalls.push(input);
        },
      },
      theme: {
        current: {
          success: '#00ff00',
          textMuted: '#888888',
          text: '#ffffff',
        },
      },
    };

    await (tui as { tui: (api: unknown) => Promise<void> }).tui(fakeApi);

    expect(registeredSlots).toHaveLength(1);
    expect(registeredSlots[0]!.names).toContain('app_bottom');
    expect(toastCalls).toHaveLength(1);
  });
});
