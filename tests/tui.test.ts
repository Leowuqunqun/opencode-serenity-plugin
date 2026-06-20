/**
 * TUI plugin 入口单测
 *
 * v1.9：default export 改为 { id, tui } 对象形式（R-β fix）
 * v1.9.1：移除 JSX slot 测试（@opentui/solid 的 JSX runtime 只支持 build-time
 *   transform，运行时 import 会 throw；v1.10 切 bun build 再加回来）
 *
 * v1.10: 测试 /serenity-init slash command 注册 + DialogPrompt UX 流程
 *
 * v1.10.1: mock tui-install（避免测试时写盘到 ~/.config/opencode/tui.json）
 *   新增 "plugin dormant 时 slash command 仍注册" 测试覆盖
 *
 * v1.15: "loaded" toast（每次加载都显示版本号）+ 自安装 toast 包含版本
 *   新增两个测试覆盖
 *
 * 测试点：
 * 1. 形状：default 是对象，含 id（string）和 tui（function）
 * 2. 行为：调用 tui(api) 应当不抛错，且调用了 toast
 * 3. 行为：调用 tui(api) 应当注册 /serenity-init slash command
 * 4. onSelect(dialog) → opens Step 1 DialogPrompt (CCC Name) with prefill
 * 5. Step 1 onConfirm(valid) → advances to Step 2 (Description)
 * 6. Full 4-step chain → initWizard (D1) + dialog.clear + toast success
 * 7. Step 1 onConfirm(invalid prefix) → toast error, dialog not clear
 * 8. Step 1 onCancel → dialog.clear + toast "Cancelled"
 * 9. dialog=undefined → toast error, no throw
 * 9. v1.10.1：plugin "dormant"（mock 掉 self-install）→ slash command 仍注册
 * 10. v1.10.1：self-install 返回 changed → toast 提示 "restart opencode"
 * 11. v1.15：loaded toast title 包含 "opencode-serenity-plugin v" + 版本号
 * 12. v1.15：self-install changed toast 包含版本号
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// v1.10.1: mock tui-install 避免测试时写到 ~/.config/opencode/tui.json
// 用 vi.hoisted 让 mock factory 在 import 之前初始化（vitest 规范）
const { mockInstall, mockToPluginSpec } = vi.hoisted(() => ({
  mockInstall: vi.fn<(pluginPath: string, options?: { configPath?: string }) => { changed: boolean; configPath: string; error?: string }>(),
  mockToPluginSpec: vi.fn<(input: string) => string>((input: string) => {
    if (input.startsWith('file://')) return input;
    return `file://${input}`;
  }),
}));

vi.mock('../src/util/tui-install.js', () => ({
  ensureGlobalTuiPluginRegistration: mockInstall,
  toPluginSpec: mockToPluginSpec,
  getGlobalTuiConfigPath: () => '/tmp/mock-tui.json',
}));

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
    // v0.1 D6: 至少 2 个 toast — "loaded"（版本号） + 宁静号状态
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // 找状态 toast（title 以 'serenity v' 开头）
    // v0.1 D6: 由 "plugin activated" 改为宁静号激活状态（Activated / Not Activated / Error）
    const status = calls.find(
      (c) =>
        (c[0] as { title?: string }).title?.startsWith('serenity v') &&
        (c[0] as { message?: string }).message?.includes('Serenity'),
    ) as [{ title?: string; message?: string; variant?: string; duration?: number }] | undefined;
    expect(status).toBeTruthy();
    // /tmp/myproj 没有 .serenity → Not Activated
    expect(status![0].message).toContain('Not Activated');
    expect(status![0].variant).toBe('info');
    expect(status![0].duration).toBe(5000);
    // 版本号必须出现
    expect(status![0].title).toMatch(/v\d+\.\d+\.\d+/);
  });

  it('注册 /serenity-init slash command', async () => {
    const api = makeMockApi();
    const cmd = await getSlashCommand(api);
    expect(cmd.value).toBe('serenity-init');
    expect(cmd.slash?.name).toBe('serenity-init');
    expect(typeof cmd.onSelect).toBe('function');
  });

  it('onSelect opens Step 1 DialogPrompt (CCC Name) with prefill', async () => {
    const api = makeMockApi('/tmp/My Cool App');
    const dialog: MockDialogStack = {
      replace: vi.fn(),
      clear: vi.fn(),
      setSize: vi.fn(),
    };
    const props = await openDialogFromSelect(api, dialog);
    expect(dialog.replace).toHaveBeenCalled();
    expect(api.ui.DialogPrompt).toHaveBeenCalled();
    expect(props.title).toBe('CCC Name');
    expect(props.placeholder).toContain('kebab-case');
    // basename('/tmp/My Cool App') = 'My Cool App' → defaultPrefix = 'my-cool-app'
    expect(props.value).toBe('my-cool-app');
  });

  it('full 4-step chain → initWizard + dialog.clear + toast success', async () => {
    const tmp = setupGitRepo();
    try {
      const api = makeMockApi(tmp);
      const dialog: MockDialogStack = { replace: vi.fn(), clear: vi.fn(), setSize: vi.fn() };

      // Step 1 — CCC Name
      const step1 = await openDialogFromSelect(api, dialog);
      expect(step1.title).toBe('CCC Name');
      await step1.onConfirm!('xx');

      // Step 2 — Description
      expect(dialog.replace).toHaveBeenCalledTimes(2); // onSelect + Step 1 onConfirm
      // dialog.replace is called with a render fn; call it to trigger DialogPrompt
      const renderFn2 = dialog.replace.mock.calls[1][0] as () => unknown;
      renderFn2();
      const step2 = api.ui.DialogPrompt.mock.calls[1][0] as MockDialogPromptProps;
      expect(step2.title).toBe('Description');
      await step2.onConfirm!('test ccc');

      // Step 3 — Git Remote
      expect(dialog.replace).toHaveBeenCalledTimes(3);
      const renderFn3 = dialog.replace.mock.calls[2][0] as () => unknown;
      renderFn3();
      const step3 = api.ui.DialogPrompt.mock.calls[2][0] as MockDialogPromptProps;
      expect(step3.title).toBe('Git Remote');
      await step3.onConfirm!('');

      // Step 4 — Scope
      expect(dialog.replace).toHaveBeenCalledTimes(4);
      const renderFn4 = dialog.replace.mock.calls[3][0] as () => unknown;
      renderFn4();
      const step4 = api.ui.DialogPrompt.mock.calls[3][0] as MockDialogPromptProps;
      expect(step4.title).toBe('Scope');
      await step4.onConfirm!('solo');

      // After initWizard
      expect(dialog.clear).toHaveBeenCalled();
      const success = api.ui.toast.mock.calls.find(
        (c) => (c[0] as { message?: string }).message?.includes('initialized'),
      );
      expect(success).toBeTruthy();
      // .serenity 已落盘
      const cat = execFileSync('cat', [join(tmp, '.serenity')], { encoding: 'utf-8' });
      expect(cat.trim()).toBe('xx-serenity');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('Step 1 onCancel closes dialog + toasts "Cancelled"', async () => {
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

  it('Step 1 onConfirm(invalid prefix) toast error, does not advance', async () => {
    const api = makeMockApi();
    const dialog: MockDialogStack = { replace: vi.fn(), clear: vi.fn(), setSize: vi.fn() };
    const props = await openDialogFromSelect(api, dialog);
    await props.onConfirm!('MyProject');
    expect(dialog.clear).not.toHaveBeenCalled();
    // Should show error toast, not advance to Step 2
    expect(dialog.replace).toHaveBeenCalledTimes(1); // only onSelect, not step advance
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

// v1.10.1: global visibility 修复 — verify slash command 仍注册 即使 self-install 失败
describe('v1.10.1 — global visibility (dormant plugin)', () => {
  beforeEach(() => {
    mockInstall.mockReset();
  });

  afterEach(() => {
    mockInstall.mockReset();
  });

  it('self-install 失败 (返回 error) → slash command 仍注册', async () => {
    // 模拟 "plugin dormant"：self-install 报告错误（permission denied / 磁盘满 / …）
    mockInstall.mockReturnValue({
      changed: false,
      configPath: '/root/.config/opencode/tui.json',
      error: 'EACCES: permission denied',
    });

    const api = makeMockApi('/tmp/non-serenity-project');
    // 必须不抛
    await expect(
      (tui as { tui: (api: unknown) => Promise<void> }).tui(api),
    ).resolves.toBeUndefined();

    // slash command 仍注册
    expect(api.command?.register).toHaveBeenCalled();
    const cb = api.command!.register.mock.calls[0][0] as () => MockCommandRegisterArg[];
    const cmds = cb();
    expect(cmds[0].value).toBe('serenity-init');
  });

  it('self-install 抛 throw（防御性）→ slash command 仍注册', async () => {
    // 即便 self-install 抛了（理论上不会，但 try/catch 包住了），slash command 仍注册
    mockInstall.mockImplementation(() => {
      throw new Error('mock install throw');
    });

    const api = makeMockApi('/tmp/non-serenity-project');
    await expect(
      (tui as { tui: (api: unknown) => Promise<void> }).tui(api),
    ).resolves.toBeUndefined();

    expect(api.command?.register).toHaveBeenCalled();
    const cb = api.command!.register.mock.calls[0][0] as () => MockCommandRegisterArg[];
    expect(cb()[0].value).toBe('serenity-init');
  });

  it('self-install changed: true → toast 提示 "restart opencode"', async () => {
    mockInstall.mockReturnValue({
      changed: true,
      configPath: '/home/yh/.config/opencode/tui.json',
    });

    const api = makeMockApi('/tmp/non-serenity-project');
    await (tui as { tui: (api: unknown) => Promise<void> }).tui(api);

    // 找到那个 "restart opencode" 的 toast
    const installToast = api.ui.toast.mock.calls.find(
      (c) => (c[0] as { message?: string }).message?.includes('restart opencode'),
    );
    expect(installToast).toBeTruthy();
    expect((installToast![0] as { variant?: string }).variant).toBe('info');
  });

  it('v1.15: loaded toast title 包含版本号', async () => {
    // 不 mock install — 测试只关心"loaded" toast 与版本号
    mockInstall.mockReturnValue({ changed: false, configPath: '/tmp/x' });

    const api = makeMockApi();
    await (tui as { tui: (api: unknown) => Promise<void> }).tui(api);

    // 找 title 以 "opencode-serenity-plugin v" 开头的 toast
    const loaded = api.ui.toast.mock.calls.find(
      (c) =>
        (c[0] as { title?: string }).title?.startsWith('opencode-serenity-plugin v'),
    ) as [{ title?: string; message?: string; variant?: string; duration?: number }] | undefined;
    expect(loaded).toBeTruthy();
    // message 是 'loaded'
    expect(loaded![0].message).toBe('loaded');
    expect(loaded![0].variant).toBe('success');
    // duration 3s 自动消失（不阻塞后续 toast）
    expect(loaded![0].duration).toBe(3000);
    // title 里必须包含 semver 子串（任意 X.Y.Z）— 不硬编码具体值
    const title = loaded![0].title!;
    expect(title).toMatch(/^opencode-serenity-plugin v\d+\.\d+\.\d+/);
  });

  it('v1.15: self-install toast 包含版本号', async () => {
    mockInstall.mockReturnValue({
      changed: true,
      configPath: '/home/yh/.config/opencode/tui.json',
    });

    const api = makeMockApi();
    await (tui as { tui: (api: unknown) => Promise<void> }).tui(api);

    // 找 install toast（message 同时包含 'installed' 和 'restart opencode'）
    const installToast = api.ui.toast.mock.calls.find(
      (c) =>
        (c[0] as { message?: string }).message?.includes('installed') &&
        (c[0] as { message?: string }).message?.includes('restart opencode'),
    ) as [{ message?: string }] | undefined;
    expect(installToast).toBeTruthy();
    // message 必须包含 semver 版本号
    expect(installToast![0].message).toMatch(/v\d+\.\d+\.\d+/);
  });

  it('self-install no-op (changed: false, 无 error) → 无额外 toast', async () => {
    // 第二次启动场景：plugin 已 global 注册，install no-op
    mockInstall.mockReturnValue({
      changed: false,
      configPath: '/home/yh/.config/opencode/tui.json',
    });

    const api = makeMockApi('/tmp/anywhere');
    await (tui as { tui: (api: unknown) => Promise<void> }).tui(api);

    // 只应有"plugin activated" toast，无 "restart" toast
    const restartToast = api.ui.toast.mock.calls.find(
      (c) => (c[0] as { message?: string }).message?.includes('restart opencode'),
    );
    expect(restartToast).toBeUndefined();
  });

  it('non-serenity cwd（无 /.serenity）slash command 仍注册', async () => {
    // 用户痛点场景：cwd 是非 serenity 目录，plugin 处于 "dormant" 状态
    // （没有 RR1 激活，server plugin 的 hooks 不工作）
    // 但 TUI plugin 的 slash command 仍应可用——这是 RR7 init 的核心
    mockInstall.mockReturnValue({ changed: false, configPath: '/tmp/x' });

    const api = makeMockApi('/tmp/some-random-non-serenity-dir');
    await (tui as { tui: (api: unknown) => Promise<void> }).tui(api);

    expect(api.command?.register).toHaveBeenCalled();
    const cb = api.command!.register.mock.calls[0][0] as () => MockCommandRegisterArg[];
    expect(cb()[0].value).toBe('serenity-init');
  });
});
