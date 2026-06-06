/**
 * TUI plugin 入口单测
 *
 * v1.9：default export 改为 { id, tui } 对象形式（R-β fix）
 * v1.9.1：移除 JSX slot 测试（@opentui/solid 的 JSX runtime 只支持 build-time
 *   transform，运行时 import 会 throw；v1.10 切 bun build 再加回来）
 *
 * v1.10: 测试 /serenity-init slash command 注册 + DialogPrompt UX 流程
 *
 * 测试点：
 * 1. 形状：default 是对象，含 id（string）和 tui（function）
 * 2. 行为：调用 tui(api) 应当不抛错，且调用了 toast
 * 3. 行为：调用 tui(api) 应当注册 /serenity-init slash command
 * 4. onSelect(dialog) → 打开 DialogPrompt with prefill（value = defaultPrefix(basename(cwd))）
 * 5. onConfirm(valid) → initSerenity + dialog.clear + toast
 * 6. onConfirm(invalid) → toast error, dialog 不 clear
 * 7. onCancel → dialog.clear + toast "Cancelled"
 * 8. dialog=undefined → toast error, no throw
 */

import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tui from '../src/tui.js';

interface MockDialogStack {
  replace: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
}

interface MockCommandRegisterArg {
  value?: string;
  slash?: { name?: string };
  onSelect?: (dialog?: MockDialogStack) => void | Promise<void>;
}

interface MockDialogPromptProps {
  title?: string;
  placeholder?: string;
  value?: string;
  onConfirm?: (value: string) => void | Promise<void>;
  onCancel?: () => void;
}

interface MockApi {
  ui: {
    toast: ReturnType<typeof vi.fn>;
    DialogPrompt: ReturnType<typeof vi.fn>;
  };
  command?: {
    register: ReturnType<typeof vi.fn>;
  };
  state: {
    path: {
      directory: string;
    };
  };
}

function makeMockApi(cwd = '/tmp/myproj'): MockApi {
  return {
    ui: {
      toast: vi.fn(),
      DialogPrompt: vi.fn(),
    },
    command: {
      register: vi.fn(),
    },
    state: {
      path: {
        directory: cwd,
      },
    },
  };
}

function setupGitRepo(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'tui-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: tmp, stdio: 'ignore' });
  return tmp;
}

async function getSlashCommand(api: MockApi): Promise<MockCommandRegisterArg> {
  await (tui as { tui: (api: unknown) => Promise<void> }).tui(api);
  const cb = api.command!.register.mock.calls[0][0] as () => MockCommandRegisterArg[];
  const cmds = cb();
  return cmds[0];
}

/**
 * opencode 的 dialog.replace 接收一个**惰性 render 函数**，由 TUI 框架在
 * 真正需要渲染时调用。我们测试中需要手动调用它来触发 DialogPrompt。
 */
async function openDialogFromSelect(
  api: MockApi,
  dialog: MockDialogStack,
): Promise<MockDialogPromptProps> {
  const cmd = await getSlashCommand(api);
  cmd.onSelect!(dialog);
  // 取出 dialog.replace 的第一个 arg（render 函数）并立即调用
  const renderFn = dialog.replace.mock.calls[0][0] as () => unknown;
  renderFn();
  const props = api.ui.DialogPrompt.mock.calls[0][0] as MockDialogPromptProps;
  return props;
}

describe('TUI plugin entry', () => {
  it('tui default export 是 { id, tui } 对象', () => {
    expect(typeof tui).toBe('object');
    expect(tui).not.toBeNull();
    expect(typeof (tui as { tui?: unknown }).tui).toBe('function');
    expect(typeof (tui as { id?: unknown }).id).toBe('string');
  });

  it('tui.tui 接受 fake api 并调用 toast', async () => {
    const api = makeMockApi();
    await (tui as { tui: (api: unknown) => Promise<void> }).tui(api);
    expect(api.ui.toast).toHaveBeenCalled();
    const calls = api.ui.toast.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const first = calls[0][0] as { title?: string; variant?: string; duration?: number };
    expect(first.title).toBe('serenity');
    expect(first.variant).toBe('success');
    expect(first.duration).toBe(5000);
  });

  it('注册 /serenity-init slash command', async () => {
    const api = makeMockApi();
    const cmd = await getSlashCommand(api);
    expect(cmd.value).toBe('serenity-init');
    expect(cmd.slash?.name).toBe('serenity-init');
    expect(typeof cmd.onSelect).toBe('function');
  });

  it('onSelect 打开 DialogPrompt with prefill', async () => {
    const api = makeMockApi('/tmp/My Cool App');
    const dialog: MockDialogStack = {
      replace: vi.fn(),
      clear: vi.fn(),
      setSize: vi.fn(),
    };
    const props = await openDialogFromSelect(api, dialog);
    expect(dialog.replace).toHaveBeenCalled();
    expect(api.ui.DialogPrompt).toHaveBeenCalled();
    expect(props.title).toBe('Initialize serenity');
    expect(props.placeholder).toBe('kebab-case prefix (e.g. xx, tg)');
    // basename('/tmp/My Cool App') = 'My Cool App' → defaultPrefix = 'my-cool-app'
    expect(props.value).toBe('my-cool-app');
  });

  it('onCancel closes dialog + toasts "Cancelled"', async () => {
    const api = makeMockApi();
    const dialog: MockDialogStack = { replace: vi.fn(), clear: vi.fn(), setSize: vi.fn() };
    const props = await openDialogFromSelect(api, dialog);
    props.onCancel!();
    expect(dialog.clear).toHaveBeenCalled();
    const cancelToast = api.ui.toast.mock.calls.find(
      (c) => (c[0] as { message?: string }).message === 'Cancelled',
    );
    expect(cancelToast).toBeTruthy();
  });

  it('onConfirm(valid) 调 initSerenity + dialog.clear + toast success', async () => {
    const tmp = setupGitRepo();
    try {
      const api = makeMockApi(tmp);
      const dialog: MockDialogStack = { replace: vi.fn(), clear: vi.fn(), setSize: vi.fn() };
      const props = await openDialogFromSelect(api, dialog);
      await props.onConfirm!('xx');
      expect(dialog.clear).toHaveBeenCalled();
      const success = api.ui.toast.mock.calls.find(
        (c) => (c[0] as { message?: string }).message?.includes('Initialized xx-serenity'),
      );
      expect(success).toBeTruthy();
      // 副作用：/.serenity 已落盘
      const cat = execFileSync('cat', [join(tmp, '.serenity')], { encoding: 'utf-8' });
      expect(cat.trim()).toBe('xx-serenity');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('onConfirm(invalid) toast error, 不 clear dialog', async () => {
    const api = makeMockApi();
    const dialog: MockDialogStack = { replace: vi.fn(), clear: vi.fn(), setSize: vi.fn() };
    const props = await openDialogFromSelect(api, dialog);
    await props.onConfirm!('MyProject');
    expect(dialog.clear).not.toHaveBeenCalled();
    const errorToast = api.ui.toast.mock.calls.find(
      (c) => (c[0] as { variant?: string }).variant === 'error',
    );
    expect(errorToast).toBeTruthy();
  });

  it('dialog=undefined → toast error, no throw', async () => {
    const api = makeMockApi();
    const cmd = await getSlashCommand(api);
    expect(() => cmd.onSelect!(undefined)).not.toThrow();
    const errorToast = api.ui.toast.mock.calls.find(
      (c) => (c[0] as { variant?: string }).variant === 'error',
    );
    expect(errorToast).toBeTruthy();
  });
});
