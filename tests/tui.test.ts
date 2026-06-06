/**
 * TUI plugin 入口单测 — smoke test
 *
 * v1.9：default export 改为 { id, tui } 对象形式（R-β fix）
 * v1.9.1：移除 JSX slot 测试（@opentui/solid 的 JSX runtime 只支持 build-time
 *   transform，运行时 import 会 throw；v1.10 切 bun build 再加回来）
 *
 * 测试点：
 * 1. 形状：default 是对象，含 id（string）和 tui（function）
 * 2. 行为：调用 tui(api) 应当不抛错，且调用了 toast
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

  it('tui.tui 接受 fake api 并调用 toast', async () => {
    const toastCalls: unknown[] = [];

    const fakeApi = {
      ui: {
        toast(input: unknown) {
          toastCalls.push(input);
        },
      },
    };

    await (tui as { tui: (api: unknown) => Promise<void> }).tui(fakeApi);

    expect(toastCalls).toHaveLength(1);
    const toast = toastCalls[0] as { title?: string; variant?: string; duration?: number };
    expect(toast.title).toBe('serenity');
    expect(toast.variant).toBe('success');
    expect(toast.duration).toBe(5000);
  });
});
